import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const TOOL_NAME = "codex_image";
const TOOL_LABEL = "pi-codex-image";
const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const GENERATED_IMAGES_DIR = "generated_images";
const DEFAULT_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 900;
const PREFLIGHT_TIMEOUT_MS = 5_000;

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({
    description: "What image to generate or how to edit the attached reference image(s).",
  }),
  inputImages: Type.Optional(
    Type.Array(Type.String({ description: "Local image path. Can be relative, absolute, or start with @." }), {
      description: "Optional local image paths to attach as references or edit targets.",
    }),
  ),
  outputPath: Type.Optional(
    Type.String({
      description:
        "Optional exact path to copy the generated image to. If Codex produces multiple images, omit this and let the agent choose one later.",
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description: "Whether to overwrite outputPath if it already exists. Default: false.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional Codex model override. If omitted, Codex uses its default configured model.",
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_SEC,
      description: `Timeout for the Codex run in seconds. Default: ${DEFAULT_TIMEOUT_SEC}.`,
    }),
  ),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

type CommandCaptureResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CodexHealth = {
  ok: boolean;
  summary: string;
  details: string[];
};

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function resolveUserPath(path: string, cwd: string): string {
  return resolve(cwd, stripAtPrefix(path));
}

async function ensureFileExists(path: string, description: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${description} not found: ${path}`);
  }
}

async function collectFilesRecursive(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function tail(text: string, maxLines = 40, maxBytes = 12_000): string {
  return truncateTail(text, { maxLines, maxBytes }).content.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = toTrimmedString(value);
    if (text) return text;
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => toTrimmedString(item))
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function prepareToolArguments(args: unknown): ToolParams {
  if (typeof args === "string") {
    return { prompt: args };
  }

  if (!isRecord(args)) {
    throw new Error(`${TOOL_NAME} expects an object with at least a prompt string.`);
  }

  const prompt = firstString(args.prompt, args.request, args.instructions, args.description, args.text);
  if (!prompt) {
    throw new Error(
      `${TOOL_NAME} requires a prompt. Accepted aliases: prompt, request, instructions, description, text.`,
    );
  }

  const inputImages = normalizeStringArray(
    args.inputImages ??
      args.input_images ??
      args.images ??
      args.image ??
      args.references ??
      args.referenceImages ??
      args.reference_images ??
      args.reference,
  );

  const outputPath = firstString(
    args.outputPath,
    args.output_path,
    args.path,
    args.output,
    args.file,
    args.filename,
  );

  const overwrite = normalizeBoolean(args.overwrite ?? args.force ?? args.replace);
  const model = firstString(args.model, args.codexModel, args.codex_model);
  const timeoutSec = normalizeInteger(args.timeoutSec ?? args.timeout_sec ?? args.timeoutSeconds ?? args.timeout);

  return {
    prompt,
    ...(inputImages ? { inputImages } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(typeof overwrite === "boolean" ? { overwrite } : {}),
    ...(model ? { model } : {}),
    ...(typeof timeoutSec === "number" ? { timeoutSec } : {}),
  };
}

function userAskedForMultipleImages(prompt: string): boolean {
  return /\b(variants?|multiple|several|set of|options|different versions|three versions|four versions)\b/i.test(prompt);
}

function buildCodexPrompt(params: ToolParams): string {
  const sections = [
    "Use Codex's built-in image_generation tool for this request.",
    "Generate raster image output and then answer briefly with what you made.",
    "Do not edit or create files in the workspace.",
  ];

  if (params.outputPath || !userAskedForMultipleImages(params.prompt)) {
    sections.push("Generate exactly one final image unless the user explicitly asked for multiple variants.");
  }

  if ((params.inputImages?.length ?? 0) > 0) {
    sections.push(
      `There ${params.inputImages!.length === 1 ? "is" : "are"} ${params.inputImages!.length} attached input image${params.inputImages!.length === 1 ? "" : "s"}. Use them as references or edit targets according to the user's request.`,
    );
  }

  if (params.outputPath) {
    sections.push("Because the caller requested outputPath, the result must be a single final image.");
  }

  sections.push(`User request:\n${params.prompt}`);
  return sections.join("\n\n");
}

function formatCodexFailure(result: CommandCaptureResult, finalMessage: string, timeoutSec: number): string {
  const stderrTail = tail(result.stderr);
  const stdoutTail = tail(result.stdout);
  const combined = `${stderrTail}\n${stdoutTail}\n${finalMessage}`.toLowerCase();
  const hints: string[] = [];

  if (result.timedOut) {
    hints.push(`Hint: Codex timed out after ${timeoutSec}s. Try a simpler prompt or increase timeoutSec.`);
  }
  if (combined.includes("no prompt provided via stdin")) {
    hints.push("Hint: the Codex CLI expected stdin prompt input. The extension now uses stdin; reload pi if you still see this.");
  }
  if (combined.includes("login") || combined.includes("auth")) {
    hints.push("Hint: ensure Codex is logged in locally (`codex login`) and that ~/.codex/auth.json exists.");
  }
  if (combined.includes("image_generation")) {
    hints.push("Hint: this Codex build may not support the image_generation feature flag expected by the extension.");
  }

  return [
    `Codex exited with code ${result.code ?? "unknown"}.`,
    stderrTail ? `stderr:\n${stderrTail}` : "",
    stdoutTail ? `stdout:\n${stdoutTail}` : "",
    finalMessage.trim() ? `last message:\n${finalMessage.trim()}` : "",
    ...hints,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function runCommandCapture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    stdinText?: string;
    signal?: AbortSignal;
    onStatus?: (text: string) => void;
  },
): Promise<CommandCaptureResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      fn();
    };

    const requestTerminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
    };

    const abortHandler = () => {
      requestTerminate();
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTerminate();
    }, options.timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        requestTerminate();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.on("error", (error) => {
      settle(() => rejectPromise(error));
    });

    if (typeof options.stdinText === "string") {
      child.stdin.write(options.stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        options.onStatus?.(`Codex: ${last}`);
      }
    });

    child.on("close", (code) => {
      settle(() => resolvePromise({ code, stdout, stderr, timedOut }));
    });
  });
}

async function detectCodexHealth(): Promise<CodexHealth> {
  const details: string[] = [];

  try {
    await access(AUTH_PATH);
    details.push(`auth: found ${AUTH_PATH}`);
  } catch {
    return {
      ok: false,
      summary: "pi-codex-image unavailable: missing Codex auth file.",
      details: [`expected auth at ${AUTH_PATH}`, "run `codex login`, then /reload in pi"],
    };
  }

  let versionText = "unknown";
  try {
    const versionResult = await runCommandCapture("codex", ["--version"], { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    versionText = firstString(versionResult.stdout, versionResult.stderr) ?? "unknown";
    details.push(`codex: ${versionText}`);
  } catch (error) {
    return {
      ok: false,
      summary: "pi-codex-image unavailable: `codex` CLI not found on PATH.",
      details: [error instanceof Error ? error.message : String(error), "install Codex CLI, then /reload in pi"],
    };
  }

  const helpResult = await runCommandCapture("codex", ["exec", "--help"], { timeoutMs: PREFLIGHT_TIMEOUT_MS }).catch(
    (error) => {
      throw new Error(error instanceof Error ? error.message : String(error));
    },
  );
  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  const missingFlags = ["--image", "--output-last-message"].filter((flag) => !helpText.includes(flag));
  if (missingFlags.length > 0) {
    return {
      ok: false,
      summary: "pi-codex-image unavailable: Codex CLI is missing required exec flags.",
      details: [`missing flags: ${missingFlags.join(", ")}`, `detected version: ${versionText}`],
    };
  }

  details.push("exec flags: --image and --output-last-message present");
  return {
    ok: true,
    summary: `pi-codex-image ready (${versionText}).`,
    details,
  };
}

function mentionsPiCodexImage(text: string): boolean {
  if (/\bpi[- ]codex[- ]image\b/i.test(text)) return true;
  if (/\bcodex_image\b/i.test(text)) return false;

  const mentionsCodex = /\b(use|ask)\s+codex\b/i.test(text) || /\bcodex image\b/i.test(text);
  const mentionsImageTask = /\b(image|diagram|logo|poster|illustration|png|icon|banner|mockup|edit)\b/i.test(text);
  return mentionsCodex && mentionsImageTask;
}

function aliasNote(toolReady: boolean, summary: string): string {
  if (toolReady) {
    return "[Extension note: the requested `pi-codex-image` capability is exposed as the `codex_image` tool. Prefer that tool for raster image generation or editing.]";
  }
  return `[Extension note: pi-codex-image is unavailable in this session (${summary}). Use /codex-image-doctor for details.]`;
}

export default async function codexImage(pi: ExtensionAPI) {
  const startupHealth = await detectCodexHealth();
  const toolReady = startupHealth.ok;

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    if (!mentionsPiCodexImage(event.text)) return { action: "continue" };
    if (event.text.includes("[Extension note:")) return { action: "continue" };
    return {
      action: "transform",
      text: `${event.text}\n\n${aliasNote(toolReady, startupHealth.summary)}`,
      images: event.images,
    };
  });

  pi.registerCommand("codex-image-doctor", {
    description: "Check whether pi-codex-image is ready to register and run.",
    handler: async (_args, ctx) => {
      const health = await detectCodexHealth();
      ctx.ui.notify(health.summary, health.ok ? "success" : "warning");
      await ctx.ui.select("pi-codex-image doctor", [health.summary, ...health.details, "Press Esc to close"]);
    },
  });

  if (!toolReady) {
    return;
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Generate or edit raster images via the local Codex CLI using Codex's built-in image_generation tool. This is the tool behind requests like `use pi-codex-image`, `ask Codex to generate an image`, or `use Codex for this diagram`. Requires `codex` to be installed and logged in with ChatGPT.",
    promptSnippet:
      "Use `codex_image` (aka `pi-codex-image`) to generate or edit raster images through the local Codex CLI; supports local references and optional outputPath copying.",
    promptGuidelines: [
      "If the user explicitly says `pi-codex-image`, `use Codex`, or asks Codex to generate/edit an image, prefer this tool.",
      "Pass inputImages when the user provides local reference images or wants an existing image edited.",
      "If outputPath is set, request exactly one final image so the tool can copy it to disk cleanly.",
    ],
    parameters: TOOL_PARAMS,
    prepareArguments: prepareToolArguments,
    async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
      await ensureFileExists(AUTH_PATH, "Codex auth file (~/.codex/auth.json)");

      const inputImages = params.inputImages ?? [];
      const resolvedInputImages = await Promise.all(
        inputImages.map(async (path) => {
          const resolvedPath = resolveUserPath(path, ctx.cwd);
          await ensureFileExists(resolvedPath, "Input image");
          return resolvedPath;
        }),
      );

      const resolvedOutputPath = params.outputPath ? resolveUserPath(params.outputPath, ctx.cwd) : undefined;

      if (resolvedOutputPath && params.outputPath && (params.outputPath.endsWith("/") || params.outputPath.endsWith("\\"))) {
        throw new Error("outputPath must be a file path, not a directory path.");
      }

      const codexHome = await mkdtemp(join(tmpdir(), "pi-codex-image-"));
      const lastMessagePath = join(codexHome, "last-message.txt");
      const timeoutSec = Math.min(Math.max(params.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);

      try {
        await copyFile(AUTH_PATH, join(codexHome, "auth.json"));

        const prompt = buildCodexPrompt(params);
        const args = [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--enable",
          "image_generation",
          "--color",
          "never",
          "--cd",
          ctx.cwd,
          "--output-last-message",
          lastMessagePath,
        ];

        if (params.model) {
          args.push("--model", params.model);
        }

        for (const imagePath of resolvedInputImages) {
          args.push("--image", imagePath);
        }

        args.push("-");

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Launching ${TOOL_LABEL}${params.model ? ` with model ${params.model}` : ""}${resolvedInputImages.length > 0 ? ` using ${resolvedInputImages.length} input image${resolvedInputImages.length === 1 ? "" : "s"}` : ""}...`,
            },
          ],
          details: {
            tool: TOOL_NAME,
            inputImages: resolvedInputImages,
            outputPath: resolvedOutputPath,
          },
        });

        const result = await runCommandCapture("codex", args, {
          cwd: ctx.cwd,
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
          },
          timeoutMs: timeoutSec * 1000,
          stdinText: prompt,
          signal,
          onStatus: (text) => {
            onUpdate?.({
              content: [{ type: "text", text }],
              details: { tool: TOOL_NAME },
            });
          },
        });

        const finalMessage = await readFile(lastMessagePath, "utf8").catch(() => "");
        const generatedRoot = join(codexHome, GENERATED_IMAGES_DIR);
        const generatedFiles = (await collectFilesRecursive(generatedRoot))
          .filter((path) => /\.(png|jpe?g|gif|webp)$/i.test(path))
          .sort();

        if (result.timedOut) {
          throw new Error(formatCodexFailure(result, finalMessage, timeoutSec));
        }

        if ((result.code ?? 1) !== 0) {
          throw new Error(formatCodexFailure(result, finalMessage, timeoutSec));
        }

        if (generatedFiles.length === 0) {
          throw new Error(
            [
              "Codex finished but no generated image was found.",
              finalMessage.trim() ? `last message:\n${finalMessage.trim()}` : "",
              result.stderr.trim() ? `stderr:\n${tail(result.stderr)}` : "",
              "Hint: verify that your Codex build supports image_generation and emitted an artifact.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
        }

        if (resolvedOutputPath && generatedFiles.length !== 1) {
          throw new Error(
            `outputPath requires exactly one generated image, but Codex produced ${generatedFiles.length}. Try a prompt that explicitly asks for a single final image.`,
          );
        }

        let copiedPath: string | undefined;
        if (resolvedOutputPath) {
          const overwrite = params.overwrite ?? false;
          if (!overwrite) {
            try {
              await access(resolvedOutputPath);
              throw new Error(`outputPath already exists: ${resolvedOutputPath}. Pass overwrite=true to replace it.`);
            } catch (error) {
              if (!(error instanceof Error) || !error.message.startsWith("outputPath already exists:")) {
                // File does not exist, which is what we want.
              } else {
                throw error;
              }
            }
          }

          copiedPath = resolvedOutputPath;
          const sourcePath = generatedFiles[0]!;
          await withFileMutationQueue(resolvedOutputPath, async () => {
            await mkdir(dirname(resolvedOutputPath), { recursive: true });
            await copyFile(sourcePath, resolvedOutputPath);
          });
        }

        const imageBuffers = await Promise.all(generatedFiles.map((path) => readFile(path)));
        const textParts = [
          `Codex generated ${generatedFiles.length} image${generatedFiles.length === 1 ? "" : "s"}.`,
          finalMessage.trim() ? `Codex summary: ${finalMessage.trim()}` : "",
          copiedPath ? `Copied final image to: ${copiedPath}` : "",
        ].filter(Boolean);

        return {
          content: [
            { type: "text", text: textParts.join(" ") },
            ...imageBuffers.map((buffer, index) => ({
              type: "image" as const,
              data: buffer.toString("base64"),
              mimeType: imageMimeType(generatedFiles[index]!),
            })),
          ],
          details: {
            tool: TOOL_NAME,
            generatedImageCount: generatedFiles.length,
            copiedPath,
            finalMessage: finalMessage.trim() || undefined,
            stdoutTail: result.stdout.trim() ? tail(result.stdout) : undefined,
            stderrTail: result.stderr.trim() ? tail(result.stderr) : undefined,
          },
        };
      } finally {
        await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}
