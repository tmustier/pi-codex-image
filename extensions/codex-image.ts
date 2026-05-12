import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { arch, homedir, platform, release } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateTail, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const TOOL_NAME = "codex_image";
const TOOL_LABEL = "pi-codex-image";
const AUTH_PATH = resolve(homedir(), ".codex", "auth.json");
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 900;
const OUTPUT_FORMAT = "png";
const OUTPUT_MIME_TYPE = "image/png";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_URL_OVERRIDE_ENV_VAR = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

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
      description: `Optional Codex model override. Defaults to ${DEFAULT_MODEL} unless PI_CODEX_IMAGE_MODEL is set.`,
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_SEC,
      description: `Timeout for the Codex image-generation request in seconds. Default: ${DEFAULT_TIMEOUT_SEC}.`,
    }),
  ),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

type CodexAuthJson = {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: unknown;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
};

type CodexAuth = {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  authJson: CodexAuthJson;
};

type CodexHealth = {
  ok: boolean;
  summary: string;
  details: string[];
};

type GeneratedImage = {
  id: string;
  status?: string;
  revisedPrompt?: string;
  base64: string;
  buffer: Buffer;
  mimeType: string;
};

type DirectCodexOutput = {
  responseId?: string;
  images: GeneratedImage[];
  messages: string[];
  outputItemTypes: string[];
  rawEventCount: number;
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

function buildUserPrompt(params: ToolParams): string {
  const sections = [
    "Use the built-in image_generation tool for this request.",
    "Generate raster image output and then answer briefly with what you made.",
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

function base64UrlToJson(segment: string): Record<string, unknown> | undefined {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const text = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  return base64UrlToJson(parts[1]!);
}

function tokenExpiresSoon(token: string | undefined): boolean {
  const payload = jwtPayload(token);
  const exp = typeof payload?.exp === "number" ? payload.exp : undefined;
  if (!exp) return false;
  return exp * 1000 <= Date.now() + TOKEN_EXPIRY_SKEW_MS;
}

function accountIdFromToken(token: string | undefined): string | undefined {
  const payload = jwtPayload(token);
  const authClaim = payload?.[OPENAI_AUTH_CLAIM];
  if (isRecord(authClaim)) {
    const accountId = toTrimmedString(authClaim.chatgpt_account_id);
    if (accountId) return accountId;
  }
  return toTrimmedString(payload?.chatgpt_account_id);
}

function parseAuthJson(raw: string): CodexAuthJson {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Codex auth file is not a JSON object.");
  }
  return parsed as CodexAuthJson;
}

function resolveAccountId(authJson: CodexAuthJson): string | undefined {
  return firstString(authJson.tokens?.account_id, accountIdFromToken(authJson.tokens?.access_token));
}

async function readCodexAuthJson(): Promise<CodexAuthJson> {
  const raw = await readFile(AUTH_PATH, "utf8");
  return parseAuthJson(raw);
}

async function writeCodexAuthJson(authJson: CodexAuthJson): Promise<void> {
  await writeFile(AUTH_PATH, `${JSON.stringify(authJson, null, 2)}\n`, "utf8");
}

function authFromJson(authJson: CodexAuthJson): CodexAuth {
  const accessToken = toTrimmedString(authJson.tokens?.access_token);
  if (!accessToken) {
    throw new Error("Codex auth file does not contain tokens.access_token. Run `codex login`, then /reload in pi.");
  }
  const accountId = resolveAccountId(authJson);
  if (!accountId) {
    throw new Error("Codex auth file does not contain a ChatGPT account id. Run `codex login`, then /reload in pi.");
  }
  return {
    accessToken,
    refreshToken: toTrimmedString(authJson.tokens?.refresh_token),
    accountId,
    authJson,
  };
}

async function refreshCodexAuth(auth: CodexAuth): Promise<CodexAuth> {
  if (!auth.refreshToken) {
    throw new Error("Codex access token expired and no refresh token is available. Run `codex login`, then /reload in pi.");
  }

  const endpoint = process.env[TOKEN_REFRESH_URL_OVERRIDE_ENV_VAR] || TOKEN_REFRESH_URL;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
    }),
  });

  if (!response.ok) {
    const body = tail(await response.text().catch(() => ""), 20, 4_000);
    throw new Error(`Codex auth refresh failed (${response.status}). Run \`codex login\` if this persists.${body ? `\n${body}` : ""}`);
  }

  const refreshed = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };

  const nextAuthJson: CodexAuthJson = {
    ...auth.authJson,
    tokens: {
      ...(auth.authJson.tokens ?? {}),
      ...(toTrimmedString(refreshed.access_token) ? { access_token: refreshed.access_token } : {}),
      ...(toTrimmedString(refreshed.refresh_token) ? { refresh_token: refreshed.refresh_token } : {}),
      account_id: accountIdFromToken(refreshed.access_token) ?? auth.accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  await writeCodexAuthJson(nextAuthJson);
  return authFromJson(nextAuthJson);
}

async function loadCodexAuth(refreshIfNeeded = true): Promise<CodexAuth> {
  await ensureFileExists(AUTH_PATH, "Codex auth file (~/.codex/auth.json)");
  const auth = authFromJson(await readCodexAuthJson());
  if (refreshIfNeeded && tokenExpiresSoon(auth.accessToken)) {
    return refreshCodexAuth(auth);
  }
  return auth;
}

function resolveCodexResponsesUrl(): string {
  const raw = process.env.PI_CODEX_IMAGE_BASE_URL || DEFAULT_CODEX_BASE_URL;
  const normalized = raw.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `pi_codex_image_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function userAgent(): string {
  return `pi-codex-image (${platform()} ${release()}; ${arch()})`;
}

function buildHeaders(auth: CodexAuth, requestId: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("chatgpt-account-id", auth.accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("originator", "pi");
  headers.set("User-Agent", userAgent());
  headers.set("session_id", requestId);
  headers.set("x-client-request-id", requestId);
  return headers;
}

async function imageContentItem(path: string, index: number): Promise<Array<Record<string, unknown>>> {
  const bytes = await readFile(path);
  const mimeType = imageMimeType(path);
  const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
  return [
    { type: "input_text", text: `<image name=[Image #${index}]>` },
    { type: "input_image", image_url: dataUrl, detail: "high" },
    { type: "input_text", text: "</image>" },
  ];
}

async function buildInputMessage(params: ToolParams, resolvedInputImages: string[]): Promise<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (let i = 0; i < resolvedInputImages.length; i += 1) {
    content.push(...(await imageContentItem(resolvedInputImages[i]!, i + 1)));
  }
  content.push({ type: "input_text", text: buildUserPrompt(params) });
  return {
    type: "message",
    role: "user",
    content,
  };
}

async function buildRequestBody(params: ToolParams, resolvedInputImages: string[], requestId: string): Promise<Record<string, unknown>> {
  const model = params.model || process.env.PI_CODEX_IMAGE_MODEL || DEFAULT_MODEL;
  return {
    model,
    store: false,
    stream: true,
    instructions:
      "You are a concise Codex image-generation adapter inside Pi. Use the image_generation tool for raster image generation or editing requests. After the image_generation tool call, answer briefly. Do not claim to have saved files; Pi will handle any requested output path.",
    input: [await buildInputMessage(params, resolvedInputImages)],
    tools: [{ type: "image_generation", output_format: OUTPUT_FORMAT }],
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    reasoning: { effort: "low", summary: "auto" },
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: requestId,
  };
}

function combineAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Codex image request timed out after ${timeoutMs}ms`)), timeoutMs);
  const abortHandler = () => controller.abort(signal?.reason ?? new Error("Codex image request aborted"));

  if (signal) {
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
    },
  };
}

async function postCodexResponses(
  body: Record<string, unknown>,
  auth: CodexAuth,
  requestId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const { signal: requestSignal, cleanup } = combineAbortSignals(signal, timeoutMs);
  try {
    return await fetch(resolveCodexResponsesUrl(), {
      method: "POST",
      headers: buildHeaders(auth, requestId),
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  } finally {
    cleanup();
  }
}

function parseSseEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const chunks = raw.replace(/\r\n/g, "\n").split("\n\n");
  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Ignore malformed SSE frames; the final no-image error includes event count/types.
    }
  }
  return events;
}

function collectMessageText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "output_text" || part.type === "text" || part.type === "input_text") {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

function collectOutputItem(item: unknown, output: DirectCodexOutput, seenImages: Set<string>): void {
  if (!isRecord(item)) return;
  const type = toTrimmedString(item.type) ?? "unknown";
  output.outputItemTypes.push(type);

  if (type === "image_generation_call") {
    const base64 = toTrimmedString(item.result);
    if (!base64) return;
    const id = toTrimmedString(item.id) ?? `image_${output.images.length + 1}`;
    const key = `${id}:${base64.length}`;
    if (seenImages.has(key)) return;
    seenImages.add(key);
    output.images.push({
      id,
      status: toTrimmedString(item.status),
      revisedPrompt: toTrimmedString(item.revised_prompt),
      base64,
      buffer: Buffer.from(base64, "base64"),
      mimeType: OUTPUT_MIME_TYPE,
    });
    return;
  }

  if (type === "message") {
    const text = collectMessageText(item);
    if (text) output.messages.push(text);
  }
}

function parseCodexResponse(raw: string): DirectCodexOutput {
  const events = parseSseEvents(raw);
  const output: DirectCodexOutput = {
    images: [],
    messages: [],
    outputItemTypes: [],
    rawEventCount: events.length,
  };
  const seenImages = new Set<string>();

  for (const event of events) {
    const eventType = toTrimmedString(event.type);
    if (eventType === "response.output_text.delta") {
      const delta = toTrimmedString(event.delta);
      if (delta) output.messages.push(delta);
    }

    if (eventType === "response.output_item.done" || eventType === "response.output_item.added") {
      collectOutputItem(event.item, output, seenImages);
    }

    if (eventType === "response.completed" || eventType === "response.done") {
      const response = isRecord(event.response) ? event.response : undefined;
      output.responseId = toTrimmedString(event.response_id) ?? toTrimmedString(response?.id) ?? output.responseId;
      if (Array.isArray(response?.output)) {
        for (const item of response.output) {
          collectOutputItem(item, output, seenImages);
        }
      }
    }
  }

  return output;
}

async function callCodexImageEndpoint(
  params: ToolParams,
  resolvedInputImages: string[],
  timeoutSec: number,
  signal: AbortSignal | undefined,
  onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void) | undefined,
): Promise<DirectCodexOutput & { model: string; endpoint: string }> {
  const requestId = createRequestId();
  const body = await buildRequestBody(params, resolvedInputImages, requestId);
  const model = String(body.model);
  const endpoint = resolveCodexResponsesUrl();
  const timeoutMs = timeoutSec * 1000;

  let auth = await loadCodexAuth(/*refreshIfNeeded*/ true);
  onUpdate?.({
    content: [{ type: "text", text: `Calling Codex image_generation endpoint with ${model}...` }],
    details: { tool: TOOL_NAME, endpoint, model, inputImages: resolvedInputImages.length },
  });

  let response = await postCodexResponses(body, auth, requestId, timeoutMs, signal);
  if (response.status === 401 && auth.refreshToken) {
    onUpdate?.({ content: [{ type: "text", text: "Codex auth expired; refreshing token and retrying..." }], details: { tool: TOOL_NAME } });
    auth = await refreshCodexAuth(auth);
    response = await postCodexResponses(body, auth, requestId, timeoutMs, signal);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Codex image endpoint failed (${response.status}): ${tail(raw, 40, 8_000)}`);
  }

  const parsed = parseCodexResponse(raw);
  return { ...parsed, model, endpoint };
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

  try {
    const auth = authFromJson(await readCodexAuthJson());
    details.push(`auth: ChatGPT account id present (${auth.accountId})`);
    details.push(`endpoint: ${resolveCodexResponsesUrl()}`);
    details.push(`default model: ${process.env.PI_CODEX_IMAGE_MODEL || DEFAULT_MODEL}`);
    details.push("transport: direct /codex/responses with hosted image_generation tool");
    if (tokenExpiresSoon(auth.accessToken)) {
      if (!auth.refreshToken) {
        return {
          ok: false,
          summary: "pi-codex-image unavailable: Codex access token appears expired and no refresh token is present.",
          details: [...details, "run `codex login`, then /reload in pi"],
        };
      }
      details.push("auth: access token needs refresh; tool will refresh on use");
    }
    return {
      ok: true,
      summary: `pi-codex-image ready for direct Codex image calls (${process.env.PI_CODEX_IMAGE_MODEL || DEFAULT_MODEL}).`,
      details,
    };
  } catch (error) {
    return {
      ok: false,
      summary: "pi-codex-image unavailable: Codex auth file is incomplete.",
      details: [error instanceof Error ? error.message : String(error), "run `codex login`, then /reload in pi"],
    };
  }
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
    description: "Check whether pi-codex-image is ready to call Codex image_generation directly.",
    handler: async (_args, ctx) => {
      const health = await detectCodexHealth();
      ctx.ui.notify(health.summary, health.ok ? "info" : "warning");
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
      "Generate or edit raster images by calling Codex's native /codex/responses image_generation tool directly. This is the tool behind requests like `use pi-codex-image`, `ask Codex to generate an image`, or `use Codex for this diagram`. Requires Codex ChatGPT auth in ~/.codex/auth.json.",
    promptSnippet:
      "Use `codex_image` (aka `pi-codex-image`) to generate or edit raster images through Codex's native image_generation endpoint; supports local references and optional outputPath copying.",
    promptGuidelines: [
      "If the user explicitly says `pi-codex-image`, `use Codex`, or asks Codex to generate/edit an image, prefer this tool.",
      "Pass inputImages when the user provides local reference images or wants an existing image edited.",
      "If outputPath is set, request exactly one final image so the tool can copy it to disk cleanly.",
    ],
    parameters: TOOL_PARAMS,
    prepareArguments: prepareToolArguments,
    async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
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

      const timeoutSec = Math.min(Math.max(params.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
      const output = await callCodexImageEndpoint(params, resolvedInputImages, timeoutSec, signal, onUpdate);

      if (output.images.length === 0) {
        throw new Error(
          [
            "Codex finished but no generated image was returned.",
            output.outputItemTypes.length > 0 ? `output item types: ${output.outputItemTypes.join(", ")}` : "no output items parsed",
            output.messages.length > 0 ? `messages:\n${tail(output.messages.join("\n"), 20, 4_000)}` : "",
            `events parsed: ${output.rawEventCount}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (resolvedOutputPath && output.images.length !== 1) {
        throw new Error(
          `outputPath requires exactly one generated image, but Codex produced ${output.images.length}. Try a prompt that explicitly asks for a single final image.`,
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
        await withFileMutationQueue(resolvedOutputPath, async () => {
          await mkdir(dirname(resolvedOutputPath), { recursive: true });
          await writeFile(resolvedOutputPath, output.images[0]!.buffer);
        });
      }

      const textParts = [
        `Codex generated ${output.images.length} image${output.images.length === 1 ? "" : "s"}.`,
        output.messages.length > 0 ? `Codex summary: ${output.messages.join(" ").trim()}` : "",
        copiedPath ? `Copied final image to: ${copiedPath}` : "",
      ].filter(Boolean);

      return {
        content: [
          { type: "text", text: textParts.join(" ") },
          ...output.images.map((image) => ({
            type: "image" as const,
            data: image.buffer.toString("base64"),
            mimeType: image.mimeType,
          })),
        ],
        details: {
          tool: TOOL_NAME,
          transport: "direct-codex-responses",
          endpoint: output.endpoint,
          model: output.model,
          responseId: output.responseId,
          generatedImageCount: output.images.length,
          outputItemTypes: output.outputItemTypes,
          imageStatuses: output.images.map((image) => image.status).filter(Boolean),
          revisedPrompts: output.images.map((image) => image.revisedPrompt).filter(Boolean),
          copiedPath,
          finalMessage: output.messages.join(" ").trim() || undefined,
        },
      };
    },
  });
}
