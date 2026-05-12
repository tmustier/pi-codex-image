# pi-codex-image

Pi extension that exposes Codex's native hosted `image_generation` capability as a Pi tool named `codex_image`.

## What changed in 0.3

Earlier versions shelled out to `codex exec` and asked the CLI to use its built-in `image_generation` tool. This version calls the Codex Responses endpoint directly:

```text
POST https://chatgpt.com/backend-api/codex/responses
```

with a hosted tool spec matching Codex source:

```json
{ "type": "image_generation", "output_format": "png" }
```

This avoids subprocesses, temporary `CODEX_HOME` directories, CLI prompt drift, and artifact scraping. Pi receives the generated image directly from the `image_generation_call.result` base64 payload.

## Why this version is smoother for agents

- **Native transport** — direct `/codex/responses` call instead of spawning the Codex CLI.
- **Codex-compatible request shape** — ChatGPT auth headers, `OpenAI-Beta: responses=experimental`, hosted `image_generation` tool, SSE parsing, and PNG output format.
- **Reference image support** — local images are attached as `input_image` data URLs, wrapped with Codex-style `<image name=[Image #N]>...</image>` labels.
- **Discoverability bridge** — user phrasing like `pi-codex-image`, `use Codex`, or `ask Codex to generate an image` maps to the canonical Pi tool name `codex_image`.
- **Output-path handling** — Pi can copy the single generated image to an exact requested path.

## What it does

When Pi calls `codex_image`, the extension:

1. checks that Codex ChatGPT auth is available at `~/.codex/auth.json`
2. refreshes the access token if it is already expired and a refresh token is present
3. converts optional local reference images into Responses `input_image` data URLs
4. calls `/codex/responses` with the hosted `image_generation` tool enabled
5. parses SSE `image_generation_call` output items
6. decodes the base64 PNG result(s)
7. returns the image(s) back to Pi
8. optionally writes the single output image to `outputPath`

## Requirements

- Pi
- Codex logged in with ChatGPT (`~/.codex/auth.json` present)

The local `codex` CLI does not need to be invoked at runtime, though `codex login` is still the easiest way to create/refresh auth.

## Install

### From git

```bash
pi install git:github.com/tmustier/pi-codex-image
```

### From a local checkout

```bash
pi install ~/.pi/agent/extensions/pi-codex-image
```

### For a one-off test

```bash
pi -e git:github.com/tmustier/pi-codex-image
```

## User phrasing that should map cleanly

These are all intended to resolve to the same extension-backed capability:

- `use pi-codex-image`
- `ask Codex to generate an image`
- `use Codex for this diagram`
- `edit this image with Codex`

The canonical callable Pi tool remains:

- `codex_image`

## Tool

### `codex_image`

Parameters:

- `prompt` — required text prompt
- `inputImages` — optional array of local image paths
- `outputPath` — optional exact file path for the final image
- `overwrite` — optional boolean for replacing `outputPath`
- `model` — optional Codex model override; defaults to `gpt-5.5` or `PI_CODEX_IMAGE_MODEL`
- `timeoutSec` — optional timeout, default `180`

The tool also normalizes common argument variants such as:

- `input_images`
- `output_path`
- `references`
- `request`
- `instructions`
- `timeout`

## Configuration

Environment variables:

- `PI_CODEX_IMAGE_MODEL` — default model override, default `gpt-5.5`
- `PI_CODEX_IMAGE_BASE_URL` — Codex backend base URL or full `/codex/responses` URL, default `https://chatgpt.com/backend-api`
- `CODEX_REFRESH_TOKEN_URL_OVERRIDE` — optional Codex OAuth refresh endpoint override, matching Codex CLI behavior

## Command

### `/codex-image-doctor`

Checks whether the extension is ready to call Codex directly, including:

- auth file presence
- ChatGPT account id presence
- resolved endpoint
- default model
- whether the access token appears expired

## Notes

- `outputPath` only works when Codex produces exactly one image.
- The extension asks Codex for a single final image by default unless the user explicitly requests variants.
- Generated image output is always requested as PNG, matching Codex's own hosted tool setup.
- Reference images are passed as data URLs; unlike Codex's Rust helper, this extension does not currently downscale very large local images before upload. If a reference-image call is slow or fails, retry with inputs resized to <=2048px on the longest side.

## License

MIT
