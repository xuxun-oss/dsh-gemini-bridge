# dsh-gemini-bridge

[![GitHub stars](https://img.shields.io/github/stars/xuxun-oss/dsh-gemini-bridge?style=flat-square)](https://github.com/xuxun-oss/dsh-gemini-bridge/stargazers)
[![GitHub license](https://img.shields.io/github/license/xuxun-oss/dsh-gemini-bridge?style=flat-square)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/xuxun-oss/dsh-gemini-bridge?style=flat-square)](https://github.com/xuxun-oss/dsh-gemini-bridge/commits/main)
[![Node version](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square)](package.json)
[![中文](https://img.shields.io/badge/readme-%E4%B8%AD%E6%96%87-blue?style=flat-square)](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh-harness) plugin that bridges **Google Gemini** multimodal vision and image generation into your DeepSeek model.

When a regular DeepSeek model needs to look at, generate, or edit an image, the plugin automatically routes to Gemini — **no model switching needed**:

| Tool | Purpose |
| --- | --- |
| `gemini_vision` | Recognize / read / describe / analyze images (OCR, objects, charts); accepts local paths or http(s) URLs |
| `gemini_generate_image` | Text-to-image generation, always followed by an **automatic vision self-check** (auto redraw with a refined prompt when the result misses the mark) |
| `gemini_optimize_image` | Edit / optimize an existing image: analyze the source → generate an improved version → self-check loop |

## ✨ Highlights

- **All-in-one, zero model switching**: use your regular DeepSeek model; the plugin routes vision / generation / editing to the right multimodal backend transparently.
- **More complete than modlens**: modlens only gives a text-only model "eyes"; this plugin is a **full loop of vision recognition + image generation + image editing + self-check feedback**, reusing your own Gemini API key — no third-party bridge, no extra subscription.
- **Automatic routing**: the DeepSeek model picks the right tool (`gemini_vision` / `gemini_generate_image` / `gemini_optimize_image`) from the injected system prompt and tool descriptions.
- **Quality gate**: every generated/edited image is checked by a vision model; failures trigger an automatic redraw with a refined prompt, and the verdict (description / pass-fail / issue list) is reported back.

## 🧩 Requirements (dependencies)

| Dependency | Requirement | Notes |
| --- | --- | --- |
| **DeepSeek Harness (`dsh`)** | ≥ `0.1.0-rc.7` (rc channel) | The host. Install dsh globally first, then load this plugin via `dsh plugin --profile web add ...` |
| **Node.js** | ≥ 18 | Host-half runtime (`engines`) |
| **`@deepseek-ai/dsh-tools`** | peer dep (`*`) | **Required**: the host half registers tools via `defineTool`. Provided by the dsh host, or auto-resolved by `pnpm install` — **no manual install needed** |
| **`react`** | ^18.2.0 (peer) | Needed by the browser half (settings page); provided by the dsh web frontend |
| **`@deepseek-ai/dsh-client-runtime`** | rc channel | Client core services, declared via `dsh.client.inject`, injected automatically by the dsh web build |
| **Backend API key** | yours | Gemini (free key from Google AI Studio) or the OpenAI-compatible backend of your choice |

> At runtime this plugin only depends on `@deepseek-ai/dsh-tools` (host half) and `react` (browser half); everything else uses Node.js built-ins. The rest of the `@deepseek-ai/*` packages ship with the dsh host and are never duplicated. Verified working with dsh `0.1.0-rc.7` + `@deepseek-ai/dsh-tools@0.1.0-rc.7`.

## 📦 Installation

### Option A: local directory (development / trial)

```bash
git clone https://github.com/xuxun-oss/dsh-gemini-bridge.git
dsh plugin --profile web add /path/to/dsh-gemini-bridge
# restart dsh web (or follow the hot-reload hint)
```

### Option B: via npm (after publishing)

```bash
dsh plugin --profile web add dsh-gemini-bridge
```

Then open **Settings → Gemini Vision Bridge**, paste a Google AI Studio API key, and click **Test Connection**.

> 💡 Get a free Gemini API key: <https://aistudio.google.com/apikey>

## 🔌 Multiple backends (not just Gemini)

A provider abstraction layer adapts different backends within the **same DeepSeek session, no model switching**:

| Backend | Vision / self-check | Image generation | Compatible platforms |
| --- | --- | --- | --- |
| `gemini` (default) | `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-2.5-pro`… | `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite), `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3-pro-image` (Nano Banana Pro), `imagen-4.0-generate-001` | Google AI Studio (free key) |
| `openai` (OpenAI-compatible) | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `qwen-vl-max`, `qwen2.5-vl-72b`, `glm-4v-plus`, `glm-4v-flash`, `moonshot-v1-vision`, `minimax-vl`, `internvl`, `deepseek-vl2`* | `gpt-image-1`, `dall-e-3`, `flux-1.1-pro`, `flux-schnell`, `stable-diffusion`, `sd3.5-large`, `ideogram`, `recraft`, `hunyuan-image`, `seedream`* | OpenAI / OpenRouter / Zhipu GLM / Alibaba Qwen / Moonshot Kimi / MiniMax / SiliconFlow / any proxy or self-hosted gateway |

\* via OpenAI-compatible endpoints or aggregators.

Switch backends from the settings page dropdown; endpoints, model lists, and auth headers (`x-goog-api-key` / `Bearer`) adapt automatically. **Any service exposing OpenAI-compatible `/chat/completions` (vision) and `/images/generations` / `/images/edits` (generation/editing) can be plugged in.**

## 🎯 Auto model selection

- Vision / self-check: `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3.1-flash-lite` → `gemini-2.5-flash`
- Image generation: `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite) → `gemini-3.1-flash-image` (Nano Banana 2) → `gemini-3-pro-image` (Nano Banana Pro) → `gemini-2.5-flash-image` → `imagen-4.0-generate-001`

Pick any official model from the dropdown, or type a custom model name; unavailable models fall back down the chain automatically.

## ⚙️ Notes

- Config (including the API key) lives in `~/.dsh/gemini-bridge.json`.
- Every generated image is checked by a vision model and the feedback is reported (closed loop, no modlens dependency).
- Images are saved to `~/.dsh/gemini-bridge-images/`; tool result cards show the image inline with a clickable link `/api/gemini-bridge/images/<file>`.
- Uses the **native Gemini REST API** (`generateContent` / `predict`) only; do not append `/openai` to the endpoint.

## ❓ FAQ

**Q: Why the "self-check" after generation?**
A: Generative models occasionally drift (missing fingers, extra digits, garbled text). After each round the plugin uses a vision model to verify the image against your request; failures trigger an automatic redraw with a refined prompt until it passes or the round limit is reached.

**Q: Do I have to use Gemini?**
A: No. Gemini is the default (free key), but the OpenAI-compatible backend accepts GPT-4o, Qwen-VL, GLM-4V, gpt-image, DALL-E, Flux, Stable Diffusion and many other models/platforms.

**Q: Is my API key safe?**
A: The key is stored only in the local `~/.dsh/gemini-bridge.json` and is used solely to call your chosen backend. The settings page only echoes the last 4 characters.

**Q: Where are generated images stored?**
A: `~/.dsh/gemini-bridge-images/`, and they are also registered as attachments so they appear inline in the session.

## 🔒 Security

- The API key is stored locally only; the settings page masks it (last 4 chars).
- The plugin's HTTP routes (`/api/gemini-bridge/*`) only accept loopback requests (non-loopback hosts get 403).
- Never commit `~/.dsh/gemini-bridge.json` to any repository.

## 🤝 Contributing

Issues and PRs are welcome:

- Report bugs / suggest models → [Issues](https://github.com/xuxun-oss/dsh-gemini-bridge/issues)
- Code changes → fork, open a PR; CI runs a syntax check automatically
- Documentation fixes in either language are appreciated

## 📄 Layout

```
lib/index.js        Host half: three tools + systemPrompt guidance + config/model HTTP routes
lib/client.js       Browser half: settings page (settings.section)
cordis.patch.yml    Bundle patch layer (insert row)
package.json        Package metadata (dsh.bundle / dsh.client)
```

## 📜 Changelog

See [CHANGELOG.md](CHANGELOG.md).

## ⚖️ License

[MIT](LICENSE) © Xun Xu (xuxun-oss)
