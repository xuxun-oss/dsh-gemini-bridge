# Changelog

All notable changes to **dsh-vision-imagen** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **统一命名（Breaking）**：内部与对外名称完全统一为 `dsh-vision-imagen`。插件注册名 / cordis patch id、配置路径 `~/.dsh/vision-imagen.json`、图片目录 `~/.dsh/vision-imagen-images/`、HTTP 路由 `/api/vision-imagen/*`、设置项 id 均从 `dsh-gemini-bridge` 迁移；工具改名（后端无关）：`gemini_vision` → `vision_read`、`gemini_generate_image` → `generate_image`、`gemini_optimize_image` → `edit_image`。旧的 `dsh-gemini-bridge` 名称与 `gemini_*` 工具名不再使用。

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
