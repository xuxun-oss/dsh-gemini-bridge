# dsh-gemini-bridge

[![GitHub stars](https://img.shields.io/github/stars/xuxun-oss/dsh-gemini-bridge?style=flat-square)](https://github.com/xuxun-oss/dsh-gemini-bridge/stargazers)
[![GitHub license](https://img.shields.io/github/license/xuxun-oss/dsh-gemini-bridge?style=flat-square)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/xuxun-oss/dsh-gemini-bridge?style=flat-square)](https://github.com/xuxun-oss/dsh-gemini-bridge/commits/main)
[![Node version](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square)](package.json)
[![English](https://img.shields.io/badge/readme-English-blue?style=flat-square)](README.en.md)

DeepSeek Harness 插件：为 DeepSeek 模型桥接 **Google Gemini** 的多模态识别与图像生成。

当 DeepSeek 模型需要看图、生图、改图时，自动调用 Gemini：

| 工具 | 作用 |
| --- | --- |
| `gemini_vision` | 识别/读取/描述/分析图片（OCR、物体、图表），支持本地路径或 http(s) URL |
| `gemini_generate_image` | 文本生图，生成后**必定用 Gemini 视觉模型自检反馈**（不达标时按优化 prompt 重绘） |
| `gemini_optimize_image` | 改图/优化已有图片：先分析原图 → 生成改进版 → 自检迭代 |

## ✨ 核心卖点：全能一体，无需切换模型

- **一个 DeepSeek 会话搞定一切**：直接用常规 DeepSeek 模型（不必换成视觉模型），需要看图、生图、改图时，插件自动路由到对应的 Gemini 多模态/生图模型——**全程零手动切换模型**。
- **比 modlens 等更完整**：modlens 只是「给纯文本模型装一只读图的眼睛」；本插件是**视觉识别 + 图像生成 + 图像编辑 + 自检反馈的完整闭环**，并且直接复用你自己的 Gemini API Key，不依赖任何第三方桥接、无额外订阅。
- **自动调用，无需操心**：识别 → `gemini_vision`；生图 → `gemini_generate_image`；改图 → `gemini_optimize_image`。DeepSeek 模型通过系统提示与工具描述自动选对工具，对用户完全透明。
- **自检闭环，质量把关**：生成/优化后，自动用 Gemini 视觉模型检查成品图，不达标按优化提示自动重绘，并把检查结论（画面描述 / 达标与否 / 问题清单）直接反馈出来。

## 📦 安装

### 方式一：本地目录（开发/试用）

```bash
git clone https://github.com/xuxun-oss/dsh-gemini-bridge.git
dsh plugin --profile web add /path/to/dsh-gemini-bridge
# 然后重启 dsh web（或按 dsh 的插件热载提示操作）
```

### 方式二：npm 安装（发布后）

```bash
dsh plugin --profile web add dsh-gemini-bridge
```

安装后打开 **设置 → Gemini 视觉桥**，填入 Google AI Studio 的 API Key，点「测试连接」即可。

> 💡 获取 Gemini API Key：<https://aistudio.google.com/apikey>（免费额度即可）。

## 🔌 多后端支持（不止 Gemini）

通过 provider 抽象层适配不同后端，**同一个 DeepSeek 会话、无需切换模型**：

| 后端 | 视觉识别/自检 | 图像生成 | 兼容平台示例 |
| --- | --- | --- | --- |
| `gemini`（默认） | `gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-2.5-pro`… | `gemini-3.1-flash-lite-image`（Nano Banana 2 Lite）、`gemini-3.1-flash-image`（Nano Banana 2）、`gemini-3-pro-image`（Nano Banana Pro）、`imagen-4.0-generate-001` | Google AI Studio（免费 Key） |
| `openai`（OpenAI 兼容） | `gpt-4o`、`gpt-4o-mini`、`gpt-4.1`、`qwen-vl-max`、`qwen2.5-vl-72b`、`glm-4v-plus`、`glm-4v-flash`、`moonshot-v1-vision`、`minimax-vl`、`internvl`、`deepseek-vl2`* | `gpt-image-1`、`dall-e-3`、`flux-1.1-pro`、`flux-schnell`、`stable-diffusion`、`sd3.5-large`、`ideogram`、`recraft`、`hunyuan-image`、`seedream`* | OpenAI / OpenRouter / 智谱 GLM / 阿里云百炼 Qwen / Moonshot Kimi / MiniMax / 硅基流动 SiliconFlow / 各类中转与自建网关 |

\* 经 OpenAI 兼容端点/聚合平台提供。

设置页「后端 Provider」下拉切换；端点、模型列表、鉴权头（`x-goog-api-key` / `Bearer`）自动适配。换后端只需填对应的 API Key 与端点，工具调用方式完全不变——**任何提供 OpenAI 兼容 `/chat/completions`（视觉）与 `/images/generations`、`/images/edits`（生图/编辑）的服务均可接入**。

## 🎯 模型自动选择（auto）

- 识别/自检：`gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3.1-flash-lite` → `gemini-2.5-flash`
- 生图：`gemini-3.1-flash-lite-image`（Nano Banana 2 Lite）→ `gemini-3.1-flash-image`（Nano Banana 2）→ `gemini-3-pro-image`（Nano Banana Pro）→ `gemini-2.5-flash-image` → `imagen-4.0-generate-001`

设置页可下拉选择任意官方模型，或输入自定义模型名；模型不可用时自动沿链降级。

## ⚙️ 说明

- 配置（含 API Key）保存在 `~/.dsh/gemini-bridge.json`。
- 生成后自动用 Gemini 视觉模型检查成品图并给出反馈（闭环，不依赖 modlens）。
- 图片保存在 `~/.dsh/gemini-bridge-images/`，工具结果卡片内联显示图片并提供可点击链接 `/api/gemini-bridge/images/<file>`。
- 仅走 **原生 Gemini REST API**（`generateContent` / `predict`），端点勿加 `/openai`。

## ❓ FAQ

**Q: 为什么生成图后还要"自检"？**
A: 生成式模型偶尔会跑偏（缺手、多指、文字错误等）。插件每轮生成后都用视觉模型核对画面与你的要求是否一致，不达标自动按优化提示重绘，直到满意或达到轮数上限。

**Q: 必须用 Gemini 吗？**
A: 不是。默认后端是 Gemini（免费 Key 即可），但通过 OpenAI 兼容后端可接入 GPT-4o、Qwen-VL、GLM-4V、gpt-image、DALL-E、Flux、Stable Diffusion 等几十种模型/平台。

**Q: 我的 API Key 安全吗？**
A: Key 只保存在本机 `~/.dsh/gemini-bridge.json`，插件仅在调用后端 API 时使用，不会上传到任何第三方。设置页只回显 Key 的后 4 位。

**Q: 图片保存在哪里？**
A: `~/.dsh/gemini-bridge-images/`，同时通过附件机制入库，可在会话中直接查看。

## 🔒 安全

- API Key 仅存本机，且设置页回显时脱敏（只显示后 4 位）。
- 插件的 HTTP 路由（`/api/gemini-bridge/*`）只允许本机回环地址访问（非 loopback 请求返回 403）。
- 请勿把 `~/.dsh/gemini-bridge.json` 提交到任何版本库。

## 🤝 贡献

欢迎提 Issue 与 PR：

- 报告 Bug / 建议新模型 → [Issues](https://github.com/xuxun-oss/dsh-gemini-bridge/issues)
- 修改代码 → Fork 后提交 PR，CI 会自动做语法检查
- 完善文档 → README 中英双语的修正同样欢迎

## 📄 目录

```
lib/index.js        宿主半：三个工具 + systemPrompt 引导 + 配置/模型 HTTP 路由
lib/client.js       浏览器半：设置页（settings.section）
cordis.patch.yml    组合 patch（insert 行）
package.json        包元数据（dsh.bundle / dsh.client）
```

## 📜 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## ⚖️ License

[MIT](LICENSE) © Xun Xu (xuxun-oss)
