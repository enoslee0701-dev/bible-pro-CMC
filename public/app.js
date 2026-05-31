/* AI Simultaneous Interpreter — browser client.
 *
 * Pipeline:
 *   1. Web Speech API streams interim + final recognition results.
 *   2. Each finalized utterance becomes a "segment", sent over WebSocket.
 *   3. The server streams back the translation, rendered live.
 *   4. A debounced "auto-fix" pass asks the server to re-read recent segments
 *      with full context and repair recognition/translation errors in place.
 */

const els = {
  status: document.getElementById("statusText"),
  statusDot: document.getElementById("statusDot"),
  sourceLang: document.getElementById("sourceLang"),
  targetLang: document.getElementById("targetLang"),
  swapBtn: document.getElementById("swapBtn"),
  autofixToggle: document.getElementById("autofixToggle"),
  ttsToggle: document.getElementById("ttsToggle"),
  micBtn: document.getElementById("micBtn"),
  micLabel: document.getElementById("micLabel"),
  liveBox: document.getElementById("liveBox"),
  liveText: document.getElementById("liveText"),
  transcript: document.getElementById("transcript"),
  emptyHint: document.getElementById("emptyHint"),
  clearBtn: document.getElementById("clearBtn"),
  note: document.getElementById("note"),
  modeBanner: document.getElementById("modeBanner"),
};

const state = {
  ws: null,
  recognition: null,
  recording: false,
  segments: new Map(), // id -> { source, translation, el, fixed }
  order: [], // ids in display order
  autofixTimer: null,
  spokenIds: new Set(),
};

// ---- WebSocket -----------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => setStatus(true, "已连接");
  ws.onclose = () => {
    setStatus(false, "连接断开 · 重连中…");
    setTimeout(connect, 1500);
  };
  ws.onerror = () => setStatus(false, "连接错误");
  ws.onmessage = (ev) => handleServerMessage(JSON.parse(ev.data));
}

function setStatus(online, text) {
  els.statusDot.classList.toggle("online", online);
  els.status.textContent = text;
  els.micBtn.disabled = !online || !state.recognition;
}

function sendWs(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "translation.delta": {
      const seg = state.segments.get(msg.id);
      if (!seg) return;
      seg.translation += msg.text;
      renderTranslation(seg, true);
      break;
    }
    case "translation.done": {
      const seg = state.segments.get(msg.id);
      if (!seg) return;
      seg.translation = msg.text;
      renderTranslation(seg, false);
      maybeSpeak(seg);
      scheduleAutoFix();
      break;
    }
    case "autofix.result": {
      applyAutoFix(msg.updates);
      break;
    }
    case "error": {
      showError(msg.message);
      if (msg.id) {
        const seg = state.segments.get(msg.id);
        if (seg && !seg.translation) {
          seg.translation = "⚠️ 翻译失败";
          renderTranslation(seg, false);
        }
      }
      break;
    }
  }
}

// ---- Segments / rendering ------------------------------------------------

function addSegment(id, source) {
  els.emptyHint.style.display = "none";

  const el = document.createElement("div");
  el.className = "segment";
  el.innerHTML = `
    <div class="badge-slot"></div>
    <div class="src"></div>
    <div class="tgt"></div>`;
  el.querySelector(".src").textContent = source;
  els.transcript.appendChild(el);

  const seg = { id, source, translation: "", el, fixed: false };
  state.segments.set(id, seg);
  state.order.push(id);
  renderTranslation(seg, true);
  scrollToBottom();
  return seg;
}

function renderTranslation(seg, streaming) {
  const tgt = seg.el.querySelector(".tgt");
  tgt.textContent = seg.translation;
  if (streaming) {
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    tgt.appendChild(cursor);
  }
  scrollToBottom();
}

function applyAutoFix(updates) {
  for (const u of updates) {
    const seg = state.segments.get(u.id);
    if (!seg || !u.changed) continue;

    seg.source = u.source;
    seg.translation = u.translation;
    seg.fixed = true;

    seg.el.querySelector(".src").textContent = u.source;
    seg.el.querySelector(".tgt").textContent = u.translation;

    const slot = seg.el.querySelector(".badge-slot");
    if (slot && !slot.querySelector(".fix-badge")) {
      const badge = document.createElement("span");
      badge.className = "fix-badge";
      badge.textContent = "AI 已修正";
      slot.appendChild(badge);
    }
    seg.el.classList.add("fixed");
    seg.el.classList.remove("fix-flash");
    void seg.el.offsetWidth; // restart the flash animation
    seg.el.classList.add("fix-flash");
  }
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

// ---- Auto-fix scheduling -------------------------------------------------

function scheduleAutoFix() {
  if (!els.autofixToggle.checked) return;
  clearTimeout(state.autofixTimer);
  // Wait until the speaker pauses, then repair the recent window.
  state.autofixTimer = setTimeout(runAutoFix, 1800);
}

function runAutoFix() {
  if (!els.autofixToggle.checked) return;
  const ids = state.order.slice(-6);
  const segments = ids
    .map((id) => state.segments.get(id))
    .filter((s) => s && s.translation && !s.translation.startsWith("⚠️"))
    .map((s) => ({ id: s.id, source: s.source, translation: s.translation }));
  if (segments.length === 0) return;

  sendWs({
    type: "autofix",
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    segments,
  });
}

// ---- Text-to-speech ------------------------------------------------------

function maybeSpeak(seg) {
  if (!els.ttsToggle.checked) return;
  if (state.spokenIds.has(seg.id)) return;
  if (!seg.translation || seg.translation.startsWith("⚠️")) return;
  state.spokenIds.add(seg.id);
  try {
    const u = new SpeechSynthesisUtterance(seg.translation);
    u.lang = els.targetLang.value;
    speechSynthesis.speak(u);
  } catch {
    /* ignore unsupported */
  }
}

// ---- Speech recognition --------------------------------------------------

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showError(
      "当前浏览器不支持语音识别，请使用 Chrome / Edge 桌面版。",
    );
    els.micBtn.disabled = true;
    return null;
  }
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = els.sourceLang.value;

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) {
        const id = `seg-${Date.now()}-${i}`;
        addSegment(id, text);
        sendWs({
          type: "translate",
          id,
          text,
          sourceLang: els.sourceLang.value,
          targetLang: els.targetLang.value,
        });
      } else {
        interim += text + " ";
      }
    }
    els.liveText.textContent = interim;
  };

  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    showError(`语音识别错误：${e.error}`);
  };

  rec.onend = () => {
    // Chrome stops periodically; restart while the user wants to keep going.
    if (state.recording) {
      try {
        rec.start();
      } catch {
        /* already started */
      }
    }
  };

  return rec;
}

function toggleRecording() {
  if (!state.recognition) return;
  if (state.recording) {
    state.recording = false;
    state.recognition.stop();
    els.micBtn.classList.remove("recording");
    els.micLabel.textContent = "开始传译";
    els.liveBox.style.display = "none";
    els.liveText.textContent = "";
  } else {
    state.recognition.lang = els.sourceLang.value;
    state.recording = true;
    try {
      state.recognition.start();
    } catch {
      /* already running */
    }
    els.micBtn.classList.add("recording");
    els.micLabel.textContent = "停止传译";
    els.liveBox.style.display = "flex";
    clearError();
  }
}

// ---- UI wiring -----------------------------------------------------------

function showError(text) {
  els.note.textContent = text;
  els.note.classList.add("error");
}
function clearError() {
  els.note.textContent = "";
  els.note.classList.remove("error");
}

async function loadConfig() {
  let cfg;
  try {
    cfg = await fetch("/api/config").then((r) => r.json());
  } catch {
    cfg = { mode: "free", autofix: false };
  }
  state.mode = cfg.mode;

  if (cfg.mode === "ai") {
    els.modeBanner.textContent =
      "🤖 AI 模式 · Claude 实时翻译，「AI 自动修复」已启用";
    els.modeBanner.className = "mode-banner ai";
  } else {
    els.modeBanner.textContent =
      "🆓 免费模式 · 普通机器翻译（无需密钥）。「AI 自动修复」需配置 API 密钥后才可用。";
    els.modeBanner.className = "mode-banner free";

    // Disable the AI auto-fix toggle — it has no effect without a key.
    els.autofixToggle.checked = false;
    els.autofixToggle.disabled = true;
    const span = els.autofixToggle.nextElementSibling;
    if (span) span.textContent = "AI 自动修复（需密钥）";
    const wrap = els.autofixToggle.closest(".toggle");
    if (wrap) wrap.style.opacity = "0.5";
  }
  els.modeBanner.hidden = false;
}

async function loadLanguages() {
  const langs = await fetch("/api/languages").then((r) => r.json());
  for (const lang of langs) {
    els.sourceLang.add(new Option(lang.label, lang.code));
    els.targetLang.add(new Option(lang.label, lang.code));
  }
  els.sourceLang.value = "zh-CN";
  els.targetLang.value = "en-US";
}

function init() {
  els.swapBtn.addEventListener("click", () => {
    const s = els.sourceLang.value;
    els.sourceLang.value = els.targetLang.value;
    els.targetLang.value = s;
    if (state.recognition) state.recognition.lang = els.sourceLang.value;
  });

  els.micBtn.addEventListener("click", toggleRecording);

  els.clearBtn.addEventListener("click", () => {
    els.transcript.innerHTML = "";
    state.segments.clear();
    state.order = [];
    state.spokenIds.clear();
    els.emptyHint.style.display = "block";
  });

  els.liveBox.style.display = "none";
}

Promise.all([loadLanguages(), loadConfig()])
  .then(() => {
    init();
    state.recognition = setupRecognition();
    connect();
  })
  .catch((err) => showError("初始化失败：" + err.message));
