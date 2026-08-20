window.__ModuleLoader__.load({ id: "dsh-vision-imagen", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";

var React = require("react");
var h = React.createElement;

function injectCss() {
  if (document.getElementById("dsh-vision-imagen-css")) return;
  var style = document.createElement("style");
  style.id = "dsh-vision-imagen-css";
  style.textContent =
    ".vi input[type=text],.vi input[type=password],.vi select{width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;box-sizing:border-box;margin:2px 0 4px}" +
    ".vi label{display:block;font-size:12px;opacity:.78;margin:10px 0 2px}" +
    ".vi button{padding:6px 14px;border-radius:6px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;cursor:pointer;margin-right:8px}" +
    ".vi button.vi-primary{background:#1a73e8;border-color:#1a73e8;color:#fff}" +
    ".vi button:disabled{opacity:.5;cursor:default}" +
    ".vi .vi-row{display:flex;align-items:center;gap:8px;margin:12px 0 4px;flex-wrap:wrap}" +
    ".vi .vi-status{font-size:12px;opacity:.85;margin-top:10px;white-space:pre-wrap}" +
    ".vi .vi-desc{font-size:12px;opacity:.7;line-height:1.6;border-left:3px solid rgba(128,128,128,.4);padding-left:8px;margin-bottom:6px}";
  document.head.appendChild(style);
}

async function api(method, path, body) {
  var res = await fetch("/api/vision-imagen" + path, {
    method: method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  var text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, message: text }; }
}

function GeminiSettingsPage() {
  var apiKeyState = React.useState(""); var apiKey = apiKeyState[0]; var setApiKey = apiKeyState[1];
  var providerState = React.useState("gemini"); var provider = providerState[0]; var setProvider = providerState[1];
  var endpointState = React.useState("https://generativelanguage.googleapis.com/v1beta"); var endpoint = endpointState[0]; var setEndpoint = endpointState[1];
  var visionModelState = React.useState("auto"); var visionModel = visionModelState[0]; var setVisionModel = visionModelState[1];
  var imageModelState = React.useState("auto"); var imageModel = imageModelState[0]; var setImageModel = imageModelState[1];
  var autoRefineState = React.useState(true); var autoRefine = autoRefineState[0]; var setAutoRefine = autoRefineState[1];
  var roundsState = React.useState(1); var rounds = roundsState[0]; var setRounds = roundsState[1];
  var visionListState = React.useState([]); var visionList = visionListState[0]; var setVisionList = visionListState[1];
  var imageListState = React.useState([]); var imageList = imageListState[0]; var setImageList = imageListState[1];
  var statusState = React.useState("加载中…"); var status = statusState[0]; var setStatus = statusState[1];
  var busyState = React.useState(false); var busy = busyState[0]; var setBusy = busyState[1];

  React.useEffect(function () {
    api("GET", "/config").then(function (c) {
      if (!c || c.error) { setStatus("读取配置失败: " + (c && c.error || "")); return; }
      setProvider(c.provider || "gemini");
      setEndpoint(c.endpoint || "https://generativelanguage.googleapis.com/v1beta");
      setVisionModel(c.visionModel || "auto");
      setImageModel(c.imageModel || "auto");
      setAutoRefine(c.autoRefine !== false);
      setRounds(c.maxRefineRounds || 1);
      setStatus(c.apiKeySet ? ("已配置 API Key（…" + c.keyHint + "）") : "尚未配置 API Key");
      if (c.apiKeySet) {
        api("GET", "/models").then(function (r) {
          if (r && r.ok) { setVisionList(r.vision || []); setImageList(r.image || []); }
        }).catch(function () {});
      }
    }).catch(function (e) { setStatus("读取配置失败: " + String(e)); });
  }, []);

  function save() {
    setBusy(true);
    api("POST", "/config", { apiKey: apiKey, provider: provider, endpoint: endpoint, visionModel: visionModel, imageModel: imageModel, autoRefine: autoRefine, maxRefineRounds: rounds })
      .then(function (r) { setStatus(r && r.ok ? "✅ 已保存" : ("保存失败: " + ((r && r.error) || ""))); })
      .catch(function (e) { setStatus("保存失败: " + String(e)); })
      .finally(function () { setBusy(false); });
  }

  function test() {
    setBusy(true);
    api("POST", "/test", { apiKey: apiKey, provider: provider, endpoint: endpoint })
      .then(function (r) {
        if (r && r.ok) { setVisionList(r.visionModels || []); setImageList(r.imageModels || []); }
        setStatus(r && r.message ? ((r.ok ? "✅ " : "❌ ") + r.message) : "测试完成");
      })
      .catch(function (e) { setStatus("测试失败: " + String(e)); })
      .finally(function () { setBusy(false); });
  }

  function refresh() {
    setBusy(true);
    api("GET", "/models")
      .then(function (r) {
        if (r && r.ok) { setVisionList(r.vision || []); setImageList(r.image || []); setStatus("模型列表已刷新"); }
        else setStatus((r && r.message) || "模型列表刷新失败");
      })
      .catch(function (e) { setStatus("模型列表刷新失败: " + String(e)); })
      .finally(function () { setBusy(false); });
  }

  function modelInput(value, setValue, list) {
    var opts = [["auto", "auto — 自动选择（推荐）"]].concat(
      list.map(function (m) { return [m.name, m.displayName ? (m.name + " — " + m.displayName) : m.name]; })
    );
    var known = ["auto"].concat(list.map(function (m) { return m.name; }));
    var isCustom = known.indexOf(value) === -1;
    var selValue = isCustom ? "__custom__" : value;
    return h(React.Fragment, null,
      h("select", {
        value: selValue,
        onChange: function (e) { setValue(e.target.value === "__custom__" ? "" : e.target.value); },
      },
        opts.map(function (o) { return h("option", { key: o[0], value: o[0] }, o[1]); }),
        h("option", { value: "__custom__" }, "自定义模型名…")
      ),
      isCustom ? h("input", {
        type: "text", value: value, placeholder: "输入模型名，例如 gemini-3.7-flash",
        onChange: function (e) { setValue(e.target.value); }, style: { marginTop: 4 },
      }) : null
    );
  }

  return h("div", { className: "vi" },
    h("div", { className: "vi-desc" },
      "用常规 DeepSeek 模型即可自动调用视觉/生图能力：vision_read（识别）、generate_image（生图，自动视觉自检）、edit_image（改图/优化）。" +
      "支持多种后端（默认 Gemini，也可选 OpenAI 兼容后端接入 Qwen-VL / GLM-4V / GPT-4o / gpt-image 等），无需手动切换模型。API Key 保存在 ~/.dsh/vision-imagen.json。"
    ),
    h("label", null, "后端 Provider"),
    h("select", { value: provider, onChange: function (e) { setProvider(e.target.value); } },
      h("option", { value: "gemini" }, "gemini — Gemini 原生（推荐）"),
      h("option", { value: "openai" }, "openai — OpenAI 兼容（可接任意中转/多模态）")
    ),
    h("label", null, "API Key"),
    h("input", { type: "password", value: apiKey, placeholder: "输入 API Key（留空保存 = 保留已保存的 Key）", onChange: function (e) { setApiKey(e.target.value); } }),
    h("label", null, "API 端点（gemini 默认 v1beta；openai 兼容默认 api.openai.com/v1）"),
    h("input", { type: "text", value: endpoint, onChange: function (e) { setEndpoint(e.target.value); } }),
    h("label", null, "多模态识别模型（vision_read / 自检用）"),
    modelInput(visionModel, setVisionModel, visionList),
    h("label", null, "图像生成模型（generate_image / edit_image）"),
    modelInput(imageModel, setImageModel, imageList),
    h("div", { className: "vi-row" },
      h("label", { style: { margin: "0 4px 0 0" } }, "生成后自动识别、优化"),
      h("input", { type: "checkbox", checked: autoRefine, onChange: function (e) { setAutoRefine(e.target.checked); } }),
      h("label", { style: { margin: "0 4px 0 16px" } }, "优化轮数"),
      h("select", { style: { width: 90 }, value: String(rounds), onChange: function (e) { setRounds(Number(e.target.value)); } },
        h("option", { value: "1" }, "1 轮"),
        h("option", { value: "2" }, "2 轮"),
        h("option", { value: "3" }, "3 轮")
      )
    ),
    h("div", { className: "vi-row" },
      h("button", { className: "vi-primary", disabled: busy, onClick: save }, busy ? "处理中…" : "保存"),
      h("button", { disabled: busy, onClick: test }, "测试连接"),
      h("button", { disabled: busy, onClick: refresh }, "刷新模型列表")
    ),
    h("div", { className: "vi-status" }, status)
  );
}

function apply(ctx) {
  injectCss();
  ctx.slots.inject(
    "settings.section",
    function () {
      return ctx.slots.register(
        { name: "settings.section", id: "vision-imagen", order: 30, label: "Vision Imagen" },
        GeminiSettingsPage
      );
    }
  );
}

module.exports = {
  apply: apply,
  inject: ["slots"]
};
return module.exports; } });
