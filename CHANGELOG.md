# Changelog

All notable changes to **dsh-gemini-bridge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Docs

- Document the dependency environment (README zh/en): dsh host ≥ `0.1.0-rc.7`, Node ≥ 18, `@deepseek-ai/dsh-tools` peer dep (host-provided, no manual install), `react` for the browser half, `@deepseek-ai/dsh-client-runtime` injected by the dsh web build, and the user-provided backend API key.

## [1.2.0] - 2026-08-19

### Added

- Provider abstraction layer: **Gemini native** + **OpenAI-compatible** backends.
- OpenAI-compatible vision: `gpt-4o` / `gpt-4o-mini` / `gpt-4.1`, plus Qwen-VL / GLM-4V / Moonshot / MiniMax / InternVL via compatible endpoints.
- OpenAI-compatible image generation: `gpt-image-1` / `dall-e-3`, plus Flux / Stable Diffusion / Hunyuan / Seedream via compatible endpoints.
- Settings page backend `Provider` selector; endpoint, model list and auth header (`x-goog-api-key` / `Bearer`) adapt automatically.
- Documentation: multi-backend compatibility matrix (OpenRouter / SiliconFlow / aggregation gateways, etc.).

## [1.1.0] - 2026-08-19

### Added

- **Closed-loop vision self-check**: every generated/optimized image is checked by the backend vision model; when `autoRefine` is enabled and the result does not match, it is redrawn with the refined prompt.
- Image files served via HTTP route `/api/gemini-bridge/images/<file>`; tool result cards show the image inline with a clickable link.
- `gemini_optimize_image` tool: analyze the source image → generate an improved version → self-check loop.
- System prompt guidance injected so a regular DeepSeek model routes to the right tool automatically.
- `cordis.patch.yml` bundle patch layer.
- Emphasis in README: all-in-one, no model switching, more complete than modlens.

## [1.0.0] - 2026-08-19

### Added

- Initial release of the DeepSeek Harness plugin bridging Google Gemini vision (`gemini_vision`) and image generation (`gemini_generate_image`).
- Settings page (settings.section) for API key, model selection and test connection.
- Config persisted to `~/.dsh/gemini-bridge.json`; generated images stored in `~/.dsh/gemini-bridge-images/`.

### Fixed

- Corrected a `useState` double-call bug in the settings page that left it stuck at "loading".
