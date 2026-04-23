# pi-codex-image

Pi extension that exposes the local Codex CLI's built-in image generation capability as a Pi tool named `codex_image`.

## Why this version is smoother for agents

This package is designed to reduce the two biggest failure modes we hit in practice:

1. **execution drift** — the extension now sends the prompt to `codex exec` over stdin, which matches the current Codex CLI behavior
2. **discoverability drift** — the extension explicitly bridges user phrasing like `pi-codex-image`, `use Codex`, or `ask Codex to generate an image` to the canonical Pi tool name `codex_image`

It also adds:

- startup preflight checks
- argument normalization (`input_images`, `output_path`, `references`, etc.)
- a `/codex-image-doctor` command
- stronger single-image behavior when `outputPath` is set

## What it does

When Pi calls `codex_image`, the extension:

1. checks that Codex is installed and logged in
2. creates a temporary `CODEX_HOME`
3. copies your Codex auth into that temp home
4. runs `codex exec` non-interactively with `image_generation` enabled
5. collects generated image file(s)
6. returns the image(s) back to Pi
7. optionally copies the single output image to a requested path

This extension does **not** call an image API directly. It is a thin bridge from Pi to the local `codex` CLI.

## Requirements

- Pi
- local `codex` CLI installed and on `PATH`
- Codex logged in with ChatGPT (`~/.codex/auth.json` present)

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
- `model` — optional Codex model override
- `timeoutSec` — optional timeout, default `180`

The tool also normalizes common argument variants such as:

- `input_images`
- `output_path`
- `references`
- `request`
- `instructions`
- `timeout`

## Command

### `/codex-image-doctor`

Checks whether the extension is ready to register and run, including:

- `codex` availability on `PATH`
- auth file presence
- required `codex exec` flags

## Notes

- `outputPath` only works when Codex produces exactly one image
- the extension asks Codex for a single final image by default unless the user explicitly requests variants
- the extension runs Codex with a temporary `CODEX_HOME` and removes it afterward

## License

MIT
