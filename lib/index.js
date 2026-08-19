// dsh-gemini-bridge — 宿主半（Host）。
// 为 DeepSeek 模型桥接 Google Gemini：注册 gemini_vision / gemini_generate_image /
// gemini_optimize_image 三个工具，注入工具引导，并提供配置读写与模型列表的 HTTP 路由
// 供浏览器设置页调用。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Cordis 插件名——必须与 cordis.patch.yml 里的行 id 一致。 */
export const name = 'dsh-gemini-bridge';

/** 硬依赖的宿主服务；缺一即进入等待。 */
export const inject = ['tools', 'attachments', 'systemPrompt', 'webServer'];

const DEFAULT_CFG = {
  apiKey: '',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  visionModel: 'auto',
  imageModel: 'auto',
  autoRefine: true,
  maxRefineRounds: 1,
};
const VISION_DEFAULTS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const IMAGE_DEFAULTS = ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001'];
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// ---- 配置持久化（~/.dsh/gemini-bridge.json，跨会话/工作区共享）----
function cfgPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'gemini-bridge.json');
}
function loadCfg() {
  try {
    const parsed = JSON.parse(readFileSync(cfgPath(), 'utf8'));
    return { ...DEFAULT_CFG, ...parsed };
  } catch {
    return { ...DEFAULT_CFG };
  }
}
function saveCfg(next) {
  mkdirSync(dirname(cfgPath()), { recursive: true });
  writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
}
function normalizeEndpoint(ep) {
  let s = String(ep || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('/openai/v1')) s = s.slice(0, -'/openai/v1'.length);
  else if (s.endsWith('/openai')) s = s.slice(0, -'/openai'.length);
  return s || DEFAULT_CFG.endpoint;
}
function maskKey(key) {
  return (key && key.length > 4) ? key.slice(-4) : (key || '');
}
function visionModels(cfg) {
  return cfg.visionModel && cfg.visionModel !== 'auto' ? [cfg.visionModel] : VISION_DEFAULTS;
}
function imageModels(cfg) {
  return cfg.imageModel && cfg.imageModel !== 'auto' ? [cfg.imageModel] : IMAGE_DEFAULTS;
}
function errMsg(res) {
  const m = res.data && res.data.error && res.data.error.message;
  return m ? String(m) : String(res.text || '').slice(0, 200);
}
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ---- Gemini REST API（Node 全局 fetch）----
async function apiRequest(method, url, apiKey, body, signal, timeoutMs) {
  const headers = { 'x-goog-api-key': apiKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: withTimeout(signal, timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, data, text };
}

async function generateContent(cfg, models, body, signal, timeoutMs) {
  let last = null;
  for (const model of models) {
    try {
      const res = await apiRequest('POST', `${cfg.endpoint}/models/${model}:generateContent`, cfg.apiKey, body, signal, timeoutMs);
      if (res.status >= 200 && res.status < 300) return { model, data: res.data };
      last = `${model}: HTTP ${res.status} — ${errMsg(res)}`;
      if (res.status === 401 || res.status === 403 || res.status === 429) break;
      if (res.status !== 404 && res.status !== 400) break;
    } catch (e) { last = `${model}: ${e && e.message || e}`; }
  }
  throw new Error('Gemini generateContent 调用失败: ' + (last || '未知错误'));
}

async function predict(cfg, models, body, signal, timeoutMs) {
  let last = null;
  for (const model of models) {
    try {
      const res = await apiRequest('POST', `${cfg.endpoint}/models/${model}:predict`, cfg.apiKey, body, signal, timeoutMs);
      if (res.status >= 200 && res.status < 300) return { model, data: res.data };
      last = `${model}: HTTP ${res.status} — ${errMsg(res)}`;
      if (res.status === 401 || res.status === 403 || res.status === 429) break;
      if (res.status !== 404 && res.status !== 400) break;
    } catch (e) { last = `${model}: ${e && e.message || e}`; }
  }
  throw new Error('Gemini predict 调用失败: ' + (last || '未知错误'));
}

async function listModels(cfg, signal) {
  const res = await apiRequest('GET', `${cfg.endpoint}/models?pageSize=200`, cfg.apiKey, undefined, signal, 60000);
  if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' — ' + errMsg(res));
  const all = (res.data.models || []).filter((m) => m && typeof m.name === 'string' && m.name.indexOf('models/') === 0);
  const toEntry = (m) => ({ name: m.name.slice(7), displayName: m.displayName || '', methods: m.supportedGenerationMethods || [] });
  const sortFn = (x, y) => ((String(x.name).indexOf('preview') !== -1 ? 1 : 0) - (String(y.name).indexOf('preview') !== -1 ? 1 : 0)) || String(x.name).localeCompare(String(y.name));
  const vision = all.filter((m) => m.name.indexOf('gemini') !== -1 && m.name.indexOf('image') === -1).map(toEntry).sort(sortFn);
  const image = all.filter((m) => m.name.indexOf('image') !== -1 || m.name.indexOf('imagen') !== -1).map(toEntry).sort(sortFn);
  return { vision, image };
}

// ---- 图片读写（node:fs + Buffer，二进制安全）----
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

function saveImageFile(buf, mime, nameBase, workspace) {
  const ext = MIME_EXT[mime] || 'png';
  const rel = '.dsh-gemini/images/' + nameBase + '.' + ext;
  const abs = resolvePath(rel, workspace);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return { rel, abs };
}

async function registerAttachment(ctx, buf, mime, name) {
  try {
    const ref = await ctx.attachments.saveImage({ data: buf, mediaType: mime, name: name || undefined });
    return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name };
  } catch { return null; }
}

// ---- 响应解析 ----
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
function parseJsonStrict(text) {
  let s = String(text || '').trim();
  const f = s.indexOf('{');
  const l = s.lastIndexOf('}');
  if (f >= 0 && l > f) s = s.slice(f, l + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// ---- 自检与迭代优化 ----
async function checkImage(cfg, b64, mime, request, signal) {
  const body = {
    contents: [{ role: 'user', parts: [
      { text: 'You are a strict image-quality reviewer. Compare the generated image with the user request. Reply with ONLY a JSON object (no markdown): {"matches": true or false, "issues": "concise list of concrete problems, or \\"none\\"", "refinedPrompt": "an improved prompt that fixes every issue; empty string when matches is true"}. User request: ' + request },
      { inline_data: { mime_type: mime, data: b64 } },
    ] }],
    generationConfig: { temperature: 0 },
  };
  const res = await generateContent(cfg, visionModels(cfg), body, signal, 120000);
  const j = parseJsonStrict(extractText(res.data));
  return { matches: !!(j && j.matches === true), issues: (j && j.issues) || '', refinedPrompt: (j && j.refinedPrompt) || '' };
}

async function generateImageOnce(cfg, prompt, refImage, signal) {
  let last = null;
  for (const model of imageModels(cfg)) {
    try {
      let res;
      if (model.indexOf('imagen') !== -1) {
        if (refImage) throw new Error('imagen 模型不支持基于参考图片的编辑，请改用 gemini-2.5-flash-image 或 gemini-3.1-flash-lite-image');
        const body = { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } };
        res = await predict(cfg, [model], body, signal, 240000);
      } else {
        const parts = [];
        if (refImage) parts.push({ inline_data: { mime_type: refImage.mime, data: refImage.b64 } });
        parts.push({ text: prompt });
        const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } };
        res = await generateContent(cfg, [model], body, signal, 240000);
      }
      const img = extractImageB64(res.data);
      if (!img) { last = model + ': 响应中未包含图片'; continue; }
      return { model: res.model, b64: img.b64, mime: img.mime };
    } catch (e) { last = model + ': ' + (e && e.message || e); }
  }
  throw new Error('图片生成失败: ' + (last || '未知错误'));
}

async function runRefineLoop(cfg, initialPrompt, refImage, refine, maxRounds, signal, compareRequest) {
  const attempts = [];
  let prompt = initialPrompt;
  let out = null;
  const rounds = refine ? Math.max(1, Math.min(3, maxRounds)) : 1;
  for (let round = 1; round <= rounds; round++) {
    out = await generateImageOnce(cfg, prompt, refImage, signal);
    attempts.push({ round, prompt, verdict: 'generated', issues: '' });
    if (!refine || round >= rounds) break;
    const check = await checkImage(cfg, out.b64, out.mime, compareRequest || prompt, signal);
    attempts[attempts.length - 1].verdict = check.matches ? 'ok' : 'needs-refinement';
    attempts[attempts.length - 1].issues = check.issues;
    if (check.matches) break;
    if (check.refinedPrompt) prompt = check.refinedPrompt;
  }
  return { out, attempts, finalPrompt: prompt };
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

const NO_KEY = 'Gemini Bridge 未配置 API Key，请在 设置 → Gemini 视觉桥 中填写。';

// ---- HTTP 路由（设置页调用）----
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
      if (req.method === 'GET' && path === '/config') {
        const cfg = loadCfg();
        json(res, 200, {
          apiKeySet: !!cfg.apiKey,
          keyHint: maskKey(cfg.apiKey),
          endpoint: normalizeEndpoint(cfg.endpoint),
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
        if (typeof a.endpoint === 'string' && a.endpoint.trim()) next.endpoint = normalizeEndpoint(a.endpoint);
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
        if (typeof a.endpoint === 'string' && a.endpoint.trim()) draft.endpoint = normalizeEndpoint(a.endpoint);
        if (!draft.apiKey) { json(res, 400, { message: '请先填写 API Key' }); return; }
        const listed = await listModels(draft);
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
        const listed = await listModels(cfg);
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
      ? '【Gemini 视觉桥】本会话已启用 Gemini 图像能力桥接。\n'
        + '- 需要识别、读取、描述、分析图片内容时，调用 gemini_vision（image 传本地路径或 http(s) 图片 URL）。\n'
        + '- 用户要求生成/绘制图片时，调用 gemini_generate_image（prompt 写详细描述；refine 开启时会自动识别检查并迭代优化）。\n'
        + '- 用户要求修改、调整、优化一张已有图片时，调用 gemini_optimize_image。\n'
        + '- 生成的图片会保存到工作区 .dsh-gemini/images/ 并返回路径给用户。'
      : ''),
  });

  ctx.tools.register(defineTool({
    name: 'gemini_vision',
    description: '使用 Google Gemini 多模态模型识别/读取/分析一张图片。当用户提到图片并要求识别内容、提取文字(OCR)、描述画面、识别物体/图表、回答图片相关问题时应调用。image 参数接受本地图片文件路径(相对当前工作区)或 http(s) 图片 URL。',
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
        const head = v.ok ? '✅ Gemini 视觉识别完成（模型 ' + v.model + '）:\n' : '❌ Gemini 视觉识别失败: ' + (v.error || '');
        return [{ type: 'text', text: head + (v.ok ? v.text : '') }];
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const cfg = loadCfg();
      if (!cfg.apiKey) return { ok: false, text: '', model: '', error: NO_KEY };
      try {
        const { b64, mime } = await readImageB64(args.image, workspaceOf(exec), exec.signal);
        const body = {
          contents: [{ role: 'user', parts: [{ text: args.question }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { temperature: 0.2 },
        };
        const res = await generateContent(cfg, visionModels(cfg), body, exec.signal, 120000);
        const text = extractText(res.data);
        return { ok: true, text: text || '(模型未返回文本)', model: res.model, error: '' };
      } catch (e) {
        return { ok: false, text: '', model: '', error: String(e && e.message || e) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'gemini_generate_image',
    description: '使用 Google Gemini 图像生成模型根据文本描述生成图片。生成后会调用视觉模型自动识别检查结果是否符合要求，并迭代优化（可通过 refine 关闭、rounds 控制轮数）。图片保存到工作区 .dsh-gemini/images/ 并返回路径。',
    parameters: {
      prompt: { type: 'string', required: true, description: '详细的图像描述（建议使用英文以获得最佳效果）' },
      refine: { type: 'boolean', description: '是否生成后自动识别检查并优化，默认 true' },
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
          prompt: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          attempts: { type: 'array', items: attemptItem, required: true },
          attachment: attachmentSchema,
          error: { type: 'string' },
        },
      },
      render(args, v) {
        const blocks = [{ type: 'text', text: v.ok ? '✅ 图片生成完成（模型 ' + v.model + '，' + v.rounds + ' 轮）\n保存路径: ' + v.path : '❌ 图片生成失败: ' + (v.error || '') }];
        if (v.ok && v.attachment) blocks.push({ type: 'image', attachment: v.attachment });
        return blocks;
      },
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const cfg = loadCfg();
      const noKey = { ok: false, model: '', path: '', prompt: args.prompt, rounds: 0, attempts: [], attachment: null, error: NO_KEY };
      if (!cfg.apiKey) return noKey;
      try {
        const refine = args.refine !== false && cfg.autoRefine !== false;
        const rounds = Math.max(1, Math.min(3, typeof args.rounds === 'number' ? Math.floor(args.rounds) : cfg.maxRefineRounds));
        const { out, attempts, finalPrompt } = await runRefineLoop(cfg, args.prompt, null, refine, rounds, exec.signal, args.prompt);
        const nameBase = 'gemini-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const buf = Buffer.from(out.b64, 'base64');
        const saved = saveImageFile(buf, out.mime, nameBase, workspaceOf(exec));
        const attachment = await registerAttachment(ctx, buf, out.mime, nameBase + '.' + (MIME_EXT[out.mime] || 'png'));
        return { ok: true, model: out.model, path: saved.rel, prompt: finalPrompt, rounds: attempts.length, attempts, attachment, error: '' };
      } catch (e) {
        return { ok: false, model: '', path: '', prompt: args.prompt, rounds: 0, attempts: [], attachment: null, error: String(e && e.message || e) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'gemini_optimize_image',
    description: '使用 Google Gemini 修改、调整或优化一张已有图片（改变风格、修复瑕疵、调整构图、替换元素等）。流程：先识别分析原图 → 生成改进版本 → 可选自检迭代。image 接受本地路径或 http(s) URL。',
    parameters: {
      image: { type: 'string', required: true, description: '待优化的本地图片文件路径或 http(s) 图片 URL' },
      instruction: { type: 'string', required: true, description: '期望的修改/优化要求' },
      refine: { type: 'boolean', description: '是否优化后自动检查再迭代，默认 true' },
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
          analysis: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          attempts: { type: 'array', items: attemptItem, required: true },
          attachment: attachmentSchema,
          error: { type: 'string' },
        },
      },
      render(args, v) {
        const blocks = [{ type: 'text', text: v.ok ? '✅ 图片优化完成（模型 ' + v.model + '，' + v.rounds + ' 轮）\n保存路径: ' + v.path + '\n分析: ' + v.analysis : '❌ 图片优化失败: ' + (v.error || '') }];
        if (v.ok && v.attachment) blocks.push({ type: 'image', attachment: v.attachment });
        return blocks;
      },
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const cfg = loadCfg();
      const noKey = { ok: false, model: '', path: '', analysis: '', prompt: '', rounds: 0, attempts: [], attachment: null, error: NO_KEY };
      if (!cfg.apiKey) return noKey;
      try {
        const src = await readImageB64(args.image, workspaceOf(exec), exec.signal);
        const abody = {
          contents: [{ role: 'user', parts: [
            { text: 'Analyze this image and decide exactly what must change to satisfy the request. Reply with ONLY a JSON object (no markdown): {"analysis": "short description of the image and the concrete problems relative to the request", "editPrompt": "a self-contained editing instruction referencing the image that fixes every problem and satisfies: ' + args.instruction + '"}' },
            { inline_data: { mime_type: src.mime, data: src.b64 } },
          ] }],
          generationConfig: { temperature: 0.2 },
        };
        const ares = await generateContent(cfg, visionModels(cfg), abody, exec.signal, 120000);
        const atext = extractText(ares.data);
        const aj = parseJsonStrict(atext);
        const editPrompt = (aj && aj.editPrompt) || ('Edit this image: ' + args.instruction);
        const analysis = (aj && aj.analysis) || atext || '已分析原图';
        const refine = args.refine !== false && cfg.autoRefine !== false;
        const rounds = Math.max(1, Math.min(3, typeof args.rounds === 'number' ? Math.floor(args.rounds) : cfg.maxRefineRounds));
        const { out, attempts, finalPrompt } = await runRefineLoop(cfg, editPrompt, src, refine, rounds, exec.signal, args.instruction);
        const nameBase = 'gemini-opt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const buf = Buffer.from(out.b64, 'base64');
        const saved = saveImageFile(buf, out.mime, nameBase, workspaceOf(exec));
        const attachment = await registerAttachment(ctx, buf, out.mime, nameBase + '.' + (MIME_EXT[out.mime] || 'png'));
        return { ok: true, model: out.model, path: saved.rel, analysis, prompt: finalPrompt, rounds: attempts.length, attempts, attachment, error: '' };
      } catch (e) {
        return { ok: false, model: '', path: '', analysis: '', prompt: '', rounds: 0, attempts: [], attachment: null, error: String(e && e.message || e) };
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/gemini-bridge',
    handler: createApiHandler(),
  }));
}
