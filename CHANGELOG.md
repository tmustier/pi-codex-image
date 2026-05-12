# Changelog

## [0.3.0] - 2026-05-12

### Changed
- Call Codex's native `/codex/responses` endpoint directly instead of spawning `codex exec`.
- Use the hosted Responses tool spec `{ "type": "image_generation", "output_format": "png" }`, matching Codex source.
- Parse `image_generation_call.result` base64 payloads directly and return them to Pi.
- Attach local reference images as Responses `input_image` data URLs with Codex-style image labels.
- Update doctor/readme language for the direct transport.

## [0.2.1] - 2026-05-07

### Changed
- Declare the `@earendil-works/pi-coding-agent` development dependency used by the extension runtime import.
- Update Pi extension imports and peer dependencies to the new `@earendil-works` namespace.
