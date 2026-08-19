window.__ModuleLoader__.load({ id: "dsh-gemini-bridge", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";

var React = require("react");
var h = React.createElement;

function injectCss() {
  if (document.getElementById("dsh-gemini-bridge-css")) return;
  var style = document.createElement("style");
  style.id = "dsh-gemini-bridge-css";
  style.textContent =
    ".gbr input[type=text],.gbr input[type=password],.gbr select{width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;box-sizing:border-box;margin:2px 0 4px}" +
    ".gbr label{display:block;font-size:12px;opacity:.78;margin:10px 0 2px}" +
    ".gbr button{padding:6px 14px;border-radius:6px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;cursor:pointer;margin-right:8px}" +
    ".gbr button.gbr-primary{background:#1a73e8;border-color:#1a73e8;color:#fff}" +
    ".gbr button:disabled{opacity:.5;cursor:default}" +
    ".gbr .gbr-row{display:flex;align-items:center;gap:8px;margin:12px 0 4px;flex-wrap:wrap}" +
    ".gbr .gbr-status{font-size:12px;opacity:.85;margin-top:10px;white-space:pre-wrap}" +
    ".gbr .gbr-desc{font-size:12px;opacity:.7;line-height:1.6;border-left:3px solid rgba(128,128,128,.4);padding-left:8px;margin-bottom:6px}";
  document.head.appendChild(style);
}

async function api(method, path, body) {
  var res = await fetch("/api/gemini-bridge" + path, {
    method: method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  var text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, message: text }; }
}

function GeminiSettingsPage() {
  var apiKeyState = React.useState(""); var apiKey = apiKeyState[0]; var setApiKey = apiKeyState[1];
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
    api("POST", "/config", { apiKey: apiKey, endpoint: endpoint, visionModel: visionModel, imageModel: imageModel, autoRefine: autoRefine, maxRefineRounds: rounds })
      .then(function (r) { setStatus(r && r.ok ? "✅ 已保存" : ("保存失败: " + ((r && r.error) || ""))); })
      .catch(function (e) { setStatus("保存失败: " + String(e)); })
      .finally(function () { setBusy(false); });
  }

  function test() {
    setBusy(true);
    api("POST", "/test", { apiKey: apiKey, endpoint: endpoint })
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

  return h("div", { className: "gbr" },
    h("div", { className: "gbr-desc" },
      "当 DeepSeek 模型需要看图或生图时，会自动调用 Gemini 工具：gemini_vision（识别）、gemini_generate_image（生图，自动识别检查并迭代优化）、gemini_optimize_image（改图/优化）。" +
      "auto 自动选择：识别优先 gemini-3.7-flash；生图优先 gemini-3.1-flash-lite-image（Nano Banana 2 Lite）。API Key 保存在 ~/.dsh/gemini-bridge.json。"
    ),
    h("label", null, "Google Gemini API Key"),
    h("input", { type: "password", value: apiKey, placeholder: "输入 API Key（留空保存 = 保留已保存的 Key）", onChange: function (e) { setApiKey(e.target.value); } }),
    h("label", null, "API 端点（原生 Gemini API，默认 v1beta，勿加 /openai）"),
    h("input", { type: "text", value: endpoint, onChange: function (e) { setEndpoint(e.target.value); } }),
    h("label", null, "多模态识别模型（gemini_vision / 自检用）"),
    modelInput(visionModel, setVisionModel, visionList),
    h("label", null, "图像生成模型（gemini_generate_image / gemini_optimize_image）"),
    modelInput(imageModel, setImageModel, imageList),
    h("div", { className: "gbr-row" },
      h("label", { style: { margin: "0 4px 0 0" } }, "生成后自动识别、优化"),
      h("input", { type: "checkbox", checked: autoRefine, onChange: function (e) { setAutoRefine(e.target.checked); } }),
      h("label", { style: { margin: "0 4px 0 16px" } }, "优化轮数"),
      h("select", { style: { width: 90 }, value: String(rounds), onChange: function (e) { setRounds(Number(e.target.value)); } },
        h("option", { value: "1" }, "1 轮"),
        h("option", { value: "2" }, "2 轮"),
        h("option", { value: "3" }, "3 轮")
      )
    ),
    h("div", { className: "gbr-row" },
      h("button", { className: "gbr-primary", disabled: busy, onClick: save }, busy ? "处理中…" : "保存"),
      h("button", { disabled: busy, onClick: test }, "测试连接"),
      h("button", { disabled: busy, onClick: refresh }, "刷新模型列表")
    ),
    h("div", { className: "gbr-status" }, status)
  );
}

function apply(ctx) {
  injectCss();
  ctx.slots.inject(
    "settings.section",
    function () {
      return ctx.slots.register(
        { name: "settings.section", id: "gemini-vision", order: 30, label: "Gemini 视觉桥" },
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
