# pi-codex-image

Pi extension that exposes the local Codex CLI's built-in image generation capability as a Pi tool named `codex_image`.

## What it does

When Pi calls `codex_image`, the extension:

1. checks for `~/.codex/auth.json`
2. creates a temporary `CODEX_HOME`
3. copies your Codex auth into that temp home
4. runs `codex exec` non-interactively with `image_generation` enabled
5. collects the generated image file(s)
6. returns the image(s) back to Pi
7. optionally copies the single output image to a requested path

This extension does **not** call an image API directly. It is a thin bridge from Pi to the local `codex` CLI.

## Requirements

- Pi
- local `codex` CLI installed and on `PATH`
- Codex logged in with ChatGPT (`~/.codex/auth.json` present)

## Install

### From npm

```bash
pi install npm:@tmustier/pi-codex-image
```

### From git

```bash
pi install git:github.com/tmustier/pi-codex-image
```

### For a one-off test

```bash
pi -e npm:@tmustier/pi-codex-image
# or
pi -e git:github.com/tmustier/pi-codex-image
```

## Tool

### `codex_image`

Parameters:

- `prompt` — required text prompt
- `inputImages` — optional array of local image paths
- `outputPath` — optional exact file path for the final image
- `overwrite` — optional boolean for replacing `outputPath`
- `model` — optional Codex model override
- `timeoutSec` — optional timeout, default `180`

## Example prompts

- "Use `codex_image` to generate a flat illustration of a magenta raccoon logo."
- "Use `codex_image` with `inputImages` to restyle this icon as a sticker."
- "Generate a hero image and save it with `outputPath` to `./art/hero.png`."

## Notes

- `outputPath` only works when Codex produces exactly one image.
- Exact pixel dimensions are best-effort and depend on Codex output.
- The extension runs Codex with a temporary `CODEX_HOME` and removes it afterward.

## License

MIT
