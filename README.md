# dsh-gemini-bridge

DeepSeek Harness 插件：为 DeepSeek 模型桥接 **Google Gemini** 的多模态识别与图像生成。

当 DeepSeek 模型需要看图、生图、改图时，自动调用 Gemini：

| 工具 | 作用 |
| --- | --- |
| `gemini_vision` | 识别/读取/描述/分析图片（OCR、物体、图表），支持本地路径或 http(s) URL |
| `gemini_generate_image` | 文本生图，生成后**必定用 Gemini 视觉模型自检反馈**（不达标时按优化 prompt 重绘） |
| `gemini_optimize_image` | 改图/优化已有图片：先分析原图 → 生成改进版 → 自检迭代 |

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-gemini-bridge
# 然后重启 dsh web（或按 dsh 的插件热载提示操作）
```

安装后打开 **设置 → Gemini 视觉桥**，填入 Google AI Studio 的 API Key，点「测试连接」即可。

## 模型自动选择（auto）

- 识别/自检：`gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3.1-flash-lite` → `gemini-2.5-flash`
- 生图：`gemini-3.1-flash-lite-image`（Nano Banana 2 Lite）→ `gemini-3.1-flash-image`（Nano Banana 2）→ `gemini-3-pro-image`（Nano Banana Pro）→ `gemini-2.5-flash-image` → `imagen-4.0-generate-001`

设置页可下拉选择任意官方模型，或输入自定义模型名；模型不可用时自动沿链降级。

## 说明

- 配置（含 API Key）保存在 `~/.dsh/gemini-bridge.json`。
- 生成后自动用 Gemini 视觉模型检查成品图并给出反馈（闭环，不依赖 modlens）。
- 图片保存在 `~/.dsh/gemini-bridge-images/`，工具结果卡片内联显示图片并提供可点击链接 `/api/gemini-bridge/images/<file>`。
- 仅走 **原生 Gemini REST API**（`generateContent` / `predict`），端点勿加 `/openai`。

## 目录

```
lib/index.js        宿主半：三个工具 + systemPrompt 引导 + 配置/模型 HTTP 路由
lib/client.js       浏览器半：设置页（settings.section）
cordis.patch.yml    组合 patch（insert 行）
package.json        包元数据（dsh.bundle / dsh.client）
```
