// dsh-gemini-bridge — 宿主半（Host）。
// 为 DeepSeek 模型桥接「视觉 + 生图」能力：注册 gemini_vision / gemini_generate_image /
// gemini_optimize_image 三个工具，注入工具引导，并提供配置读写、模型列表与图片服务的
// HTTP 路由供浏览器设置页调用。
//
// 模型无关设计：通过 provider 抽象层适配不同后端——gemini（原生）与 openai（OpenAI
// 兼容，可接 Qwen-VL / GLM-4V / Moonshot / GPT-4o / gpt-image / 各类中转聚合等）。
// 用常规 DeepSeek 模型即可自动路由到对应后端的视觉/生图模型，无需手动切换模型。
//
// 闭环设计：生图/改图完成后，必定调用所选后端的视觉模型对成品图自检（matches /
// issues / description / refinedPrompt），反馈写进工具结果文本——模型侧理解图片
// 完全走后端视觉，不依赖 modlens。GUI 侧通过 presentResult 卡片内联显示图片，
// 并提供可点击的图片链接（/api/gemini-bridge/images/<file>）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Cordis 插件名——必须与 cordis.patch.yml 里的行 id 一致。 */
export const name = 'dsh-gemini-bridge';

/** 硬依赖的宿主服务；缺一即进入等待。 */
export const inject = ['tools', 'attachments', 'systemPrompt', 'webServer'];

const GEMINI_EP = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_EP = 'https://api.openai.com/v1';

const DEFAULT_CFG = {
  apiKey: '',
  provider: 'gemini', // 'gemini' | 'openai'（OpenAI 兼容）
  endpoint: GEMINI_EP,
  visionModel: 'auto',
  imageModel: 'auto',
  autoRefine: true,
  maxRefineRounds: 1,
};
const GEMINI_VISION = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const GEMINI_IMAGE = ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001'];
const OPENAI_VISION = ['gpt-4o-mini', 'gpt-4o'];
const OPENAI_IMAGE = ['gpt-image-1', 'dall-e-3'];
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** 生成图片的固定落盘目录（HTTP 路由据此提供图片链接）。 */
const IMAGE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'gemini-bridge-images');

// ---- 配置持久化（~/.dsh/gemini-bridge.json，跨会话/工作区共享）----
function cfgPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'gemini-bridge.json');
}
function loadCfg() {
  try {
    const parsed = JSON.parse(readFileSync(cfgPath(), 'utf8'));
    const cfg = { ...DEFAULT_CFG, ...parsed };
    if (cfg.provider !== 'gemini' && cfg.provider !== 'openai') cfg.provider = 'gemini';
    return cfg;
  } catch {
    return { ...DEFAULT_CFG };
  }
}
function saveCfg(next) {
  mkdirSync(dirname(cfgPath()), { recursive: true });
  writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
}
function normalizeEndpoint(ep, provider) {
  let s = String(ep || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('/openai/v1')) s = s.slice(0, -'/openai/v1'.length);
  else if (s.endsWith('/openai')) s = s.slice(0, -'/openai'.length);
  if (s.endsWith('/chat/completions')) s = s.slice(0, -'/chat/completions'.length);
  return s || (provider === 'openai' ? OPENAI_EP : GEMINI_EP);
}
function maskKey(key) {
  return (key && key.length > 4) ? key.slice(-4) : (key || '');
}
function errMsg(res) {
  const m = res.data && res.data.error && res.data.error.message;
  return m ? String(m) : String(res.text || '').slice(0, 200);
}
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ---- HTTP 基础（按后端选择鉴权头）----
async function apiRequest(method, url, key, body, signal, timeoutMs, opts = {}) {
  const headers = {};
  if (opts.bearer) headers['Authorization'] = 'Bearer ' + key;
  else headers['x-goog-api-key'] = key;
  let payload;
  if (body !== undefined) {
    if (opts.form) { payload = body; /* FormData：fetch 自动带 multipart boundary */ }
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const res = await fetch(url, { method, headers, body: payload, signal: withTimeout(signal, timeoutMs) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, data, text };
}

// ---- Provider 抽象层 ----
function getProvider(cfg) {
  return cfg.provider === 'openai' ? openaiProvider : geminiProvider;
}
function visionModels(cfg) {
  return cfg.visionModel && cfg.visionModel !== 'auto' ? [cfg.visionModel] : getProvider(cfg).visionDefaults;
}
function imageModels(cfg) {
  return cfg.imageModel && cfg.imageModel !== 'auto' ? [cfg.imageModel] : getProvider(cfg).imageDefaults;
}

function extractText(data) {
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
}
function extractImageB64(data) {
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  for (const p of parts) {
    if (p && p.inlineData && p.inlineData.data) return { b64: p.inlineData.data, mime: p.inlineData.mimeType || 'image/png' };
  }
  if (data && data.predictions && data.predictions[0] && data.predictions[0].bytesBase64Encoded) {
    return { b64: data.predictions[0].bytesBase64Encoded, mime: 'image/png' };
  }
  return null;
}
function openaiText(data) {
  const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
  return '';
}
async function openaiImageFromData(data, signal) {
  const item = data && data.data && data.data[0];
  if (!item) return null;
  if (item.b64_json) return { b64: item.b64_json, mime: 'image/png' };
  if (item.url) {
    const res = await fetch(item.url, { signal: withTimeout(signal, 90000) });
    if (!res.ok) throw new Error('图片 URL 下载失败: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    const mime = ct && ct.indexOf('image/') === 0 ? ct.split(';')[0] : 'image/png';
    return { b64: buf.toString('base64'), mime };
  }
  return null;
}
function parseJsonStrict(text) {
  let s = String(text || '').trim();
  const f = s.indexOf('{');
  const l = s.lastIndexOf('}');
  if (f >= 0 && l > f) s = s.slice(f, l + 1);
  try { return JSON.parse(s); } catch { return null; }
}

const geminiProvider = {
  id: 'gemini',
  label: 'Gemini（原生）',
  defaultEndpoint: GEMINI_EP,
  visionDefaults: GEMINI_VISION,
  imageDefaults: GEMINI_IMAGE,
  async listModels(cfg, signal) {
    const res = await apiRequest('GET', `${cfg.endpoint}/models?pageSize=200`, cfg.apiKey, undefined, signal, 60000);
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    const all = (res.data.models || []).filter((m) => m && typeof m.name === 'string' && m.name.indexOf('models/') === 0);
    const toEntry = (m) => ({ name: m.name.slice(7), displayName: m.displayName || '', methods: m.supportedGenerationMethods || [] });
    const sortFn = (x, y) => ((String(x.name).indexOf('preview') !== -1 ? 1 : 0) - (String(y.name).indexOf('preview') !== -1 ? 1 : 0)) || String(x.name).localeCompare(String(y.name));
    const vision = all.filter((m) => m.name.indexOf('gemini') !== -1 && m.name.indexOf('image') === -1).map(toEntry).sort(sortFn);
    const image = all.filter((m) => m.name.indexOf('image') !== -1 || m.name.indexOf('imagen') !== -1).map(toEntry).sort(sortFn);
    return { vision, image };
  },
  async vision(cfg, model, text, image, signal) {
    const body = {
      contents: [{ role: 'user', parts: [{ text }, { inline_data: { mime_type: image.mime, data: image.b64 } }] }],
      generationConfig: { temperature: 0.2 },
    };
    const res = await apiRequest('POST', `${cfg.endpoint}/models/${model}:generateContent`, cfg.apiKey, body, signal, 120000);
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    return { model, text: extractText(res.data) };
  },
  async check(cfg, model, image, request, signal) {
    const body = {
      contents: [{ role: 'user', parts: [
        { text: 'You are a strict image-quality reviewer. Look at the image. Reply with ONLY a JSON object (no markdown): {"description": "a one-sentence description of what the image shows", "matches": true or false, "issues": "concise list of concrete problems, or \\"none\\"", "refinedPrompt": "an improved prompt that fixes every issue; empty string when matches is true"}. User request: ' + request },
        { inline_data: { mime_type: image.mime, data: image.b64 } },
      ] }],
      generationConfig: { temperature: 0 },
    };
    const res = await apiRequest('POST', `${cfg.endpoint}/models/${model}:generateContent`, cfg.apiKey, body, signal, 120000);
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    return parseCheck(extractText(res.data));
  },
  async generateImage(cfg, model, prompt, refImage, signal) {
    let res;
    if (model.indexOf('imagen') !== -1) {
      if (refImage) throw new Error('imagen 模型不支持基于参考图片的编辑，请改用 gemini-3.1-flash-lite-image 等');
      const body = { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } };
      res = await apiRequest('POST', `${cfg.endpoint}/models/${model}:predict`, cfg.apiKey, body, signal, 240000);
    } else {
      const parts = [];
      if (refImage) parts.push({ inline_data: { mime_type: refImage.mime, data: refImage.b64 } });
      parts.push({ text: prompt });
      const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } };
      res = await apiRequest('POST', `${cfg.endpoint}/models/${model}:generateContent`, cfg.apiKey, body, signal, 240000);
    }
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    const img = extractImageB64(res.data);
    if (!img) throw new Error('响应中未包含图片');
    return { model, b64: img.b64, mime: img.mime };
  },
};

const openaiProvider = {
  id: 'openai',
  label: 'OpenAI 兼容（可接任意中转/聚合/多模态）',
  defaultEndpoint: OPENAI_EP,
  visionDefaults: OPENAI_VISION,
  imageDefaults: OPENAI_IMAGE,
  async listModels(cfg, signal) {
    const res = await apiRequest('GET', `${cfg.endpoint}/models`, cfg.apiKey, undefined, signal, 60000, { bearer: true });
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    const all = (res.data.data || []).filter((m) => m && typeof m.id === 'string');
    const toEntry = (m) => ({ name: m.id, displayName: m.id, methods: [] });
    const vision = all.filter((m) => !/image|dall-e|flux|imagen|tts|audio|embedding|whisper|realtime/i.test(m.id)).map(toEntry).sort((a, b) => a.name.localeCompare(b.name));
    const image = all.filter((m) => /image|dall-e|flux|imagen/i.test(m.id)).map(toEntry).sort((a, b) => a.name.localeCompare(b.name));
    return { vision, image };
  },
  async vision(cfg, model, text, image, signal) {
    const body = {
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } },
      ] }],
    };
    const res = await apiRequest('POST', `${cfg.endpoint}/chat/completions`, cfg.apiKey, body, signal, 120000, { bearer: true });
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    return { model, text: openaiText(res.data) };
  },
  async check(cfg, model, image, request, signal) {
    const text = 'You are a strict image-quality reviewer. Look at the image. Reply with ONLY a JSON object (no markdown): {"description": "a one-sentence description of what the image shows", "matches": true or false, "issues": "concise list of concrete problems, or \\"none\\"", "refinedPrompt": "an improved prompt that fixes every issue; empty string when matches is true"}. User request: ' + request;
    const body = {
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } },
      ] }],
      temperature: 0,
    };
    const res = await apiRequest('POST', `${cfg.endpoint}/chat/completions`, cfg.apiKey, body, signal, 120000, { bearer: true });
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    return parseCheck(openaiText(res.data));
  },
  async generateImage(cfg, model, prompt, refImage, signal) {
    let res;
    if (refImage) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', '1');
      const ext = MIME_EXT[refImage.mime] || 'png';
      form.append('image', new Blob([Buffer.from(refImage.b64, 'base64')], { type: refImage.mime }), 'image.' + ext);
      res = await apiRequest('POST', `${cfg.endpoint}/images/edits`, cfg.apiKey, form, signal, 240000, { bearer: true, form: true });
    } else {
      const body = { model, prompt, n: 1, size: '1024x1024' };
      res = await apiRequest('POST', `${cfg.endpoint}/images/generations`, cfg.apiKey, body, signal, 240000, { bearer: true });
    }
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
    const img = await openaiImageFromData(res.data, signal);
    if (!img) throw new Error('响应中未包含图片');
    return { model, b64: img.b64, mime: img.mime };
  },
};

function parseCheck(text) {
  const j = parseJsonStrict(text);
  return {
    matches: !!(j && j.matches === true),
    issues: (j && j.issues) || '',
    refinedPrompt: (j && j.refinedPrompt) || '',
    description: (j && j.description) || '',
  };
}

// ---- 图片读写 ----
function extToMime(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  return 'image/png';
}
function guessMimeFromUrl(url) {
  const p = String(url).split('?')[0];
  return extToMime(p.split('.').pop());
}
function resolvePath(p, workspace) {
  return isAbsolute(p) ? p : join(workspace || process.cwd(), p);
}

async function readImageB64(imageRef, workspace, signal) {
  if (/^https?:\/\//i.test(imageRef)) {
    const res = await fetch(imageRef, { signal: withTimeout(signal, 90000) });
    if (!res.ok) throw new Error('图片下载失败: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    const mime = ct && ct.indexOf('image/') === 0 ? ct.split(';')[0] : guessMimeFromUrl(imageRef);
    return { b64: buf.toString('base64'), mime };
  }
  const abs = resolvePath(imageRef, workspace);
  let buf;
  try { buf = readFileSync(abs); } catch { throw new Error('图片文件不存在: ' + imageRef); }
  return { b64: buf.toString('base64'), mime: extToMime(extname(abs)) };
}

function saveImageFile(buf, mime, nameBase) {
  const ext = MIME_EXT[mime] || 'png';
  const name = nameBase + '.' + ext;
  const abs = join(IMAGE_DIR, name);
  mkdirSync(IMAGE_DIR, { recursive: true });
  writeFileSync(abs, buf);
  return { path: abs, name, url: '/api/gemini-bridge/images/' + name };
}

async function registerAttachment(ctx, buf, mime, name) {
  try {
    const ref = await ctx.attachments.saveImage({ data: buf, mediaType: mime, name: name || undefined });
    return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name };
  } catch { return null; }
}

// ---- 自检闭环（后端视觉，绝不走 modlens）----
async function generateImageOnce(cfg, provider, prompt, refImage, signal) {
  let last = null;
  for (const model of imageModels(cfg)) {
    try {
      return await provider.generateImage(cfg, model, prompt, refImage, signal);
    } catch (e) { last = model + ': ' + (e && e.message || e); }
  }
  throw new Error('图片生成失败: ' + (last || '未知错误'));
}

/** 每轮生成后必做一次视觉自检；refine 开启且未达标时用 refinedPrompt 重绘。 */
async function runRefineLoop(cfg, provider, initialPrompt, refImage, refine, maxRounds, signal, compareRequest) {
  const attempts = [];
  let prompt = initialPrompt;
  let out = null;
  let check = null;
  const rounds = Math.max(1, Math.min(3, maxRounds));
  for (let round = 1; round <= rounds; round++) {
    out = await generateImageOnce(cfg, provider, prompt, refImage, signal);
    check = await runCheck(cfg, provider, out, compareRequest || prompt, signal);
    attempts.push({ round, prompt, verdict: check.matches ? 'ok' : 'needs-refinement', issues: check.issues });
    if (!refine || check.matches || round >= rounds) break;
    if (check.refinedPrompt) prompt = check.refinedPrompt;
  }
  return { out, attempts, finalPrompt: prompt, check };
}

async function runCheck(cfg, provider, image, request, signal) {
  let last = null;
  for (const model of visionModels(cfg)) {
    try { return await provider.check(cfg, model, image, request, signal); }
    catch (e) { last = model + ': ' + (e && e.message || e); }
  }
  return { matches: false, issues: last || '自检失败', refinedPrompt: '', description: '' };
}

function workspaceOf(exec) {
  return (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || process.cwd();
}

// ---- 输出 schema ----
const attemptItem = {
  type: 'object',
  properties: {
    round: { type: 'integer', required: true },
    prompt: { type: 'string', required: true },
    verdict: { type: 'string', required: true },
    issues: { type: 'string', required: true },
  },
  additionalProperties: false,
};
const attachmentSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};
const feedbackSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        matches: { type: 'boolean', required: true },
        issues: { type: 'string', required: true },
        description: { type: 'string', required: true },
      },
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

const NO_KEY = 'Gemini Bridge 未配置 API Key，请在 设置 → Gemini 视觉桥 中填写。';

function resultCard(meta, title, extraText) {
  if (!meta || !meta.attachment) return undefined;
  const blocks = [{ type: 'image', attachment: meta.attachment }];
  const lines = [extraText || '', '后端 ' + meta.provider + ' · 模型 ' + meta.model + ' · ' + meta.rounds + ' 轮', '🔗 ' + meta.url, '📁 ' + meta.path].filter(Boolean);
  if (meta.feedback) {
    lines.push('🔍 视觉自检: ' + (meta.feedback.matches ? '符合要求' : '需优化') + (meta.feedback.issues ? ' — ' + meta.feedback.issues : ''));
  }
  blocks.push({ type: 'text', text: lines.join('\n') });
  return { card: 'generic', title: title || '图像生成', content: blocks };
}

// ---- HTTP 路由（设置页 + 图片服务）----
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
function networkGuard(req) {
  const host = String(req.headers && req.headers.host || '');
  if (!LOOPBACK_HOST.test(host)) return 'forbidden: non-loopback host';
  const origin = req.headers && req.headers.origin;
  if (origin !== undefined) {
    const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
    if (origin !== scheme + '://' + host) return 'forbidden: cross-origin';
  }
  const secFetchSite = req.headers && req.headers['sec-fetch-site'];
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return 'forbidden: cross-site';
  return null;
}
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function createApiHandler() {
  return async (req, res) => {
    const denied = networkGuard(req);
    if (denied !== null) { json(res, 403, { error: denied }); return; }
    const url = new URL(req.url || '', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/gemini-bridge/, '');
    try {
      // 图片服务：GET /images/<file>
      if (req.method === 'GET' && path.indexOf('/images/') === 0) {
        const name = decodeURIComponent(path.slice('/images/'.length));
        if (!/^[A-Za-z0-9._-]+$/.test(name)) { json(res, 400, { error: 'bad name' }); return; }
        let buf;
        try { buf = readFileSync(join(IMAGE_DIR, name)); } catch { json(res, 404, { error: 'not found' }); return; }
        res.writeHead(200, { 'content-type': extToMime(extname(name)), 'cache-control': 'public, max-age=3600' });
        res.end(buf);
        return;
      }
      if (req.method === 'GET' && path === '/config') {
        const cfg = loadCfg();
        json(res, 200, {
          apiKeySet: !!cfg.apiKey,
          keyHint: maskKey(cfg.apiKey),
          provider: cfg.provider,
          endpoint: normalizeEndpoint(cfg.endpoint, cfg.provider),
          visionModel: cfg.visionModel,
          imageModel: cfg.imageModel,
          autoRefine: cfg.autoRefine,
          maxRefineRounds: cfg.maxRefineRounds,
        });
        return;
      }
      if (req.method === 'POST' && path === '/config') {
        const a = await readJsonBody(req);
        const cfg = loadCfg();
        const next = { ...cfg };
        if (typeof a.apiKey === 'string' && a.apiKey.trim()) next.apiKey = a.apiKey.trim();
        if (a.provider === 'gemini' || a.provider === 'openai') next.provider = a.provider;
        if (typeof a.endpoint === 'string' && a.endpoint.trim()) next.endpoint = normalizeEndpoint(a.endpoint, next.provider);
        if (typeof a.visionModel === 'string' && a.visionModel) next.visionModel = a.visionModel;
        if (typeof a.imageModel === 'string' && a.imageModel) next.imageModel = a.imageModel;
        if (typeof a.autoRefine === 'boolean') next.autoRefine = a.autoRefine;
        if (typeof a.maxRefineRounds === 'number') next.maxRefineRounds = Math.max(1, Math.min(3, Math.floor(a.maxRefineRounds)));
        if (!next.apiKey) { json(res, 400, { error: 'API Key 不能为空' }); return; }
        saveCfg(next);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && path === '/test') {
        const a = await readJsonBody(req);
        const cfg = loadCfg();
        const draft = { ...cfg };
        if (typeof a.apiKey === 'string' && a.apiKey.trim()) draft.apiKey = a.apiKey.trim();
        if (a.provider === 'gemini' || a.provider === 'openai') draft.provider = a.provider;
        if (typeof a.endpoint === 'string' && a.endpoint.trim()) draft.endpoint = normalizeEndpoint(a.endpoint, draft.provider);
        if (!draft.apiKey) { json(res, 400, { message: '请先填写 API Key' }); return; }
        const listed = await getProvider(draft).listModels(draft);
        json(res, 200, {
          ok: true,
          message: '连接成功：发现 ' + listed.vision.length + ' 个视觉候选模型、' + listed.image.length + ' 个生图候选模型',
          visionModels: listed.vision,
          imageModels: listed.image,
        });
        return;
      }
      if (req.method === 'GET' && path === '/models') {
        const cfg = loadCfg();
        if (!cfg.apiKey) { json(res, 400, { message: '未配置 API Key' }); return; }
        const listed = await getProvider(cfg).listModels(cfg);
        json(res, 200, { ok: true, vision: listed.vision, image: listed.image });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e && e.message || e) });
    }
  };
}

export function apply(ctx) {
  const cfgNow = () => loadCfg();

  ctx.systemPrompt.section({
    name: 'gemini-bridge',
    order: 150,
    text: () => (cfgNow().apiKey
      ? '【视觉桥】本会话已启用图像能力桥接（后端: ' + cfgNow().provider + '）。\n'
        + '- 需要识别、读取、描述、分析图片内容时，调用 gemini_vision（image 传本地路径或 http(s) 图片 URL）。\n'
        + '- 用户要求生成/绘制图片时，调用 gemini_generate_image（prompt 写详细描述；生成后会自动用后端视觉模型检查并反馈）。\n'
        + '- 用户要求修改、调整、优化一张已有图片时，调用 gemini_optimize_image。\n'
        + '- 生成的图片会保存到 ~/.dsh/gemini-bridge-images/ 并在结果中提供图片链接。'
      : ''),
  });

  ctx.tools.register(defineTool({
    name: 'gemini_vision',
    description: '使用所选后端的多模态模型识别/读取/分析一张图片（默认 Gemini；也可配置为 OpenAI 兼容后端如 Qwen-VL / GLM-4V / GPT-4o 等）。当用户提到图片并要求识别内容、提取文字(OCR)、描述画面、识别物体/图表、回答图片相关问题时应调用。image 参数接受本地图片文件路径(相对当前工作区)或 http(s) 图片 URL。',
    parameters: {
      image: { type: 'string', required: true, description: '本地图片文件路径或 http(s) 图片 URL' },
      question: { type: 'string', required: true, description: '针对图片要识别或回答的具体问题' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render(args, v) {
        const head = v.ok ? '✅ 视觉识别完成（模型 ' + v.model + '）:\n' : '❌ 视觉识别失败: ' + (v.error || '');
        return [{ type: 'text', text: head + (v.ok ? v.text : '') }];
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const cfg = loadCfg();
      if (!cfg.apiKey) return { ok: false, text: '', model: '', error: NO_KEY };
      try {
        const image = await readImageB64(args.image, workspaceOf(exec), exec.signal);
        let last = null;
        for (const model of visionModels(cfg)) {
          try {
            const res = await getProvider(cfg).vision(cfg, model, args.question, image, exec.signal);
            return { ok: true, text: res.text || '(模型未返回文本)', model: res.model, error: '' };
          } catch (e) { last = model + ': ' + (e && e.message || e); }
        }
        return { ok: false, text: '', model: '', error: '视觉调用失败: ' + (last || '未知错误') };
      } catch (e) {
        return { ok: false, text: '', model: '', error: String(e && e.message || e) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'gemini_generate_image',
    description: '使用所选后端的图像生成模型根据文本描述生成图片（默认 Gemini Nano Banana；也可配置为 OpenAI 兼容后端如 gpt-image-1 / dall-e-3 等）。生成后必定调用后端视觉模型自动检查结果是否符合要求并给出反馈（refine 开启且不达标时按优化后的 prompt 重绘，rounds 控制最大轮数）。图片会保存并提供链接。',
    parameters: {
      prompt: { type: 'string', required: true, description: '详细的图像描述（建议使用英文以获得最佳效果）' },
      refine: { type: 'boolean', description: '是否在自检不达标时重绘优化，默认 true' },
      rounds: { type: 'integer', description: '最大生成/优化轮数 1-3，默认取设置中的轮数' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          path: { type: 'string', required: true },
          url: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          attempts: { type: 'array', items: attemptItem, required: true },
          attachment: attachmentSchema,
          feedback: feedbackSchema,
          error: { type: 'string' },
        },
      },
      render(args, v) {
        if (!v.ok) return [{ type: 'text', text: '❌ 图片生成失败: ' + (v.error || '') }];
        const lines = ['✅ 图片生成完成（模型 ' + v.model + '，' + v.rounds + ' 轮）', '🔗 图片链接: ' + v.url, '📁 保存路径: ' + v.path];
        if (v.feedback) {
          lines.push('🔍 视觉自检: ' + (v.feedback.matches ? '符合要求' : '需优化') + (v.feedback.issues ? ' — ' + v.feedback.issues : ''));
          if (v.feedback.description) lines.push('🖼️ 画面内容: ' + v.feedback.description);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
      presentationMeta(args, v) {
        return { path: v.path, url: v.url, model: v.model, provider: v.provider, rounds: v.rounds, prompt: v.prompt, attachment: v.attachment, feedback: v.feedback };
      },
    },
    presentResult(args, result) {
      return resultCard(result.meta, '图像生成', '');
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const cfg = loadCfg();
      const noKey = { ok: false, model: '', path: '', url: '', prompt: args.prompt, rounds: 0, attempts: [], attachment: null, feedback: null, error: NO_KEY };
      if (!cfg.apiKey) return noKey;
      try {
        const provider = getProvider(cfg);
        const refine = args.refine !== false && cfg.autoRefine !== false;
        const rounds = Math.max(1, Math.min(3, typeof args.rounds === 'number' ? Math.floor(args.rounds) : cfg.maxRefineRounds));
        const { out, attempts, finalPrompt, check } = await runRefineLoop(cfg, provider, args.prompt, null, refine, rounds, exec.signal, args.prompt);
        const nameBase = (cfg.provider === 'openai' ? 'img-' : 'gemini-') + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const buf = Buffer.from(out.b64, 'base64');
        const saved = saveImageFile(buf, out.mime, nameBase);
        const attachment = await registerAttachment(ctx, buf, out.mime, saved.name);
        const feedback = check ? { matches: check.matches, issues: check.issues, description: check.description } : null;
        return { ok: true, model: out.model, path: saved.path, url: saved.url, prompt: finalPrompt, rounds: attempts.length, attempts, attachment, feedback, error: '' };
      } catch (e) {
        return { ok: false, model: '', path: '', url: '', prompt: args.prompt, rounds: 0, attempts: [], attachment: null, feedback: null, error: String(e && e.message || e) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'gemini_optimize_image',
    description: '使用所选后端的图像模型修改、调整或优化一张已有图片（改变风格、修复瑕疵、调整构图、替换元素等）。流程：先识别分析原图 → 生成改进版本 → 生成后自动自检反馈。图片会保存并提供链接。',
    parameters: {
      image: { type: 'string', required: true, description: '待优化的本地图片文件路径或 http(s) 图片 URL' },
      instruction: { type: 'string', required: true, description: '期望的修改/优化要求' },
      refine: { type: 'boolean', description: '是否在自检不达标时重绘优化，默认 true' },
      rounds: { type: 'integer', description: '最大优化轮数 1-3，默认取设置中的轮数' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          path: { type: 'string', required: true },
          url: { type: 'string', required: true },
          analysis: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          attempts: { type: 'array', items: attemptItem, required: true },
          attachment: attachmentSchema,
          feedback: feedbackSchema,
          error: { type: 'string' },
        },
      },
      render(args, v) {
        if (!v.ok) return [{ type: 'text', text: '❌ 图片优化失败: ' + (v.error || '') }];
        const lines = ['✅ 图片优化完成（模型 ' + v.model + '，' + v.rounds + ' 轮）', '🔗 图片链接: ' + v.url, '📁 保存路径: ' + v.path, '📋 分析: ' + v.analysis];
        if (v.feedback) {
          lines.push('🔍 视觉自检: ' + (v.feedback.matches ? '符合要求' : '需优化') + (v.feedback.issues ? ' — ' + v.feedback.issues : ''));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
      presentationMeta(args, v) {
        return { path: v.path, url: v.url, model: v.model, provider: v.provider, rounds: v.rounds, prompt: v.prompt, attachment: v.attachment, feedback: v.feedback };
      },
    },
    presentResult(args, result) {
      return resultCard(result.meta, '图像优化', result.meta && result.meta.analysis ? '📋 ' + result.meta.analysis : '');
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const cfg = loadCfg();
      const noKey = { ok: false, model: '', path: '', url: '', analysis: '', prompt: '', rounds: 0, attempts: [], attachment: null, feedback: null, error: NO_KEY };
      if (!cfg.apiKey) return noKey;
      try {
        const provider = getProvider(cfg);
        const src = await readImageB64(args.image, workspaceOf(exec), exec.signal);
        const promptForAnalysis = 'Analyze this image and decide exactly what must change to satisfy the request. Reply with ONLY a JSON object (no markdown): {"analysis": "short description of the image and the concrete problems relative to the request", "editPrompt": "a self-contained editing instruction referencing the image that fixes every problem and satisfies: ' + args.instruction + '"}';
        let analysis = '已分析原图';
        let editPrompt = 'Edit this image: ' + args.instruction;
        let last = null;
        for (const model of visionModels(cfg)) {
          try {
            const res = await provider.vision(cfg, model, promptForAnalysis, src, exec.signal);
            const aj = parseJsonStrict(res.text);
            if (aj && aj.editPrompt) editPrompt = aj.editPrompt;
            if (aj && aj.analysis) analysis = aj.analysis;
            else if (res.text) analysis = res.text;
            break;
          } catch (e) { last = model + ': ' + (e && e.message || e); }
        }
        if (!editPrompt) throw new Error('原图分析失败: ' + (last || '未知错误'));
        const refine = args.refine !== false && cfg.autoRefine !== false;
        const rounds = Math.max(1, Math.min(3, typeof args.rounds === 'number' ? Math.floor(args.rounds) : cfg.maxRefineRounds));
        const { out, attempts, finalPrompt, check } = await runRefineLoop(cfg, provider, editPrompt, src, refine, rounds, exec.signal, args.instruction);
        const nameBase = (cfg.provider === 'openai' ? 'img-opt-' : 'gemini-opt-') + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const buf = Buffer.from(out.b64, 'base64');
        const saved = saveImageFile(buf, out.mime, nameBase);
        const attachment = await registerAttachment(ctx, buf, out.mime, saved.name);
        const feedback = check ? { matches: check.matches, issues: check.issues, description: check.description } : null;
        return { ok: true, model: out.model, path: saved.path, url: saved.url, analysis, prompt: finalPrompt, rounds: attempts.length, attempts, attachment, feedback, error: '' };
      } catch (e) {
        return { ok: false, model: '', path: '', url: '', analysis: '', prompt: '', rounds: 0, attempts: [], attachment: null, feedback: null, error: String(e && e.message || e) };
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/gemini-bridge',
    handler: createApiHandler(),
  }));
}
