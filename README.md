# AI 同声传译 · Real-time AI Simultaneous Interpreter

A real-time, browser-based simultaneous interpretation app powered by Claude,
with a built-in **AI auto-repair** layer that retroactively fixes speech-
recognition and translation errors as more context becomes available.

![pipeline](https://img.shields.io/badge/realtime-streaming-blue) ![ai-autofix](https://img.shields.io/badge/AI-auto--repair-orange)

## How it works

```
  🎤 你说话
   │
   ▼
  Browser SpeechRecognition  ──interim──►  live preview
   │ (final utterance)
   ▼
  WebSocket ──►  Node server ──►  Claude (streaming translation)
   ▲                                   │
   │            translated text ◄──────┘   实时显示译文
   │
   └── debounced AI auto-fix:  re-reads the last few segments with full
       context and repairs ASR / translation mistakes in place. Corrected
       segments are highlighted with an "AI 已修正" badge.
```

Two complementary AI passes:

1. **Real-time translation** — every finalized speech segment is streamed to
   Claude, which silently reconstructs what the speaker likely meant (fixing
   homophones, missing punctuation, fragments) and streams back a fluent
   translation token-by-token.
2. **AI auto-repair** — when the speaker pauses, a second pass re-examines the
   recent window of segments *together*. With the full context it catches
   errors that weren't visible segment-by-segment — wrong proper nouns,
   inconsistent terminology, mis-recognized words — and updates both the source
   transcript and the translation live.

## Features

- ⚡ Real-time streaming translations (token-by-token)
- 🛠️ Automatic AI error correction with visual highlighting
- 🌐 15 languages, any-to-any, swap with one click
- 🔊 Optional spoken output (text-to-speech) of the translation
- 🧠 Rolling conversational context for coherent interpretation
- 💸 Prompt caching on the system prompt to cut cost/latency

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure your API key
cp .env.example .env
#    then edit .env and set ANTHROPIC_API_KEY

# 3. Run
npm start
```

Open <http://localhost:3000>, pick your source/target languages, click
**开始传译 (Start)**, and talk.

> **Browser support:** speech recognition uses the Web Speech API, which works
> best in desktop **Chrome** or **Edge**. Translation and auto-fix work in any
> browser, but the microphone capture needs a Chromium-based browser.

## Two modes

| | **FREE mode** (default) | **AI mode** |
| --- | --- | --- |
| API key | ❌ none needed | ✅ `ANTHROPIC_API_KEY` |
| Translation | Keyless machine translation (MyMemory) | Claude, streaming |
| AI auto-repair | ❌ disabled | ✅ enabled |
| Quality | Ordinary machine translation | High, context-aware |
| Cost | Free | Pay-as-you-go (Anthropic) |

The mode is chosen automatically: **no key → free mode; key present → AI mode.**
The UI shows a banner telling you which mode is active. To force free mode even
with a key set, set `TRANSLATOR=free`.

## 在手机上使用（安卓）· Deploy from your phone

The app is a server + browser front-end, so you deploy it once and then open
the URL on your phone. **Speech input works in Android Chrome** (iOS Safari does
not support the Web Speech API). One-click, **no API key required** with the
included `render.yaml`:

1. 在手机浏览器打开 <https://render.com>，用 GitHub 账号登录。
2. 点 **New +** → **Blueprint**，选择这个仓库
   (`enoslee0701-dev/bible-pro-cmc`)，分支
   `claude/ai-simultaneous-interpretation-EbIqQ`。
3. Render 读取 `render.yaml` 后直接部署 —— **无需填任何密钥**（默认免费模式）。
4. 等几分钟部署完成，会得到一个网址，例如
   `https://ai-interpreter-xxxx.onrender.com`。
5. 用**安卓 Chrome**打开该网址 → 选语言 → 点「开始传译」→ 允许麦克风权限 → 说话。

> 提示：Render 免费套餐闲置后会休眠，第一次访问可能要等 ~30 秒唤醒，之后就正常了。
>
> **想升级到完整 AI 功能**（Claude 翻译 + AI 自动修复）？在 Render 控制台的
> Environment 里加一个 `ANTHROPIC_API_KEY` 环境变量即可，应用会自动切换到 AI 模式。

## Configuration

| Variable            | Default            | Description                                              |
| ------------------- | ------------------ | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | —                  | Required. Your Anthropic API key.                       |
| `PORT`              | `3000`             | HTTP/WebSocket port.                                    |
| `MODEL`             | `claude-opus-4-8`  | Translation model. For the lowest latency on a live feed, set `claude-haiku-4-5`; `claude-sonnet-4-6` is a good middle ground. |

## Project layout

```
src/
  server.ts        Express + WebSocket server
  interpreter.ts   Claude calls: streaming translate + structured auto-fix
  languages.ts     Supported-language registry
  protocol.ts      WebSocket message types
public/
  index.html       UI
  app.js           Client: recognition, streaming, auto-fix, TTS
  styles.css       Styling
```

## Notes

- The app is stateless on the server beyond a short in-memory rolling context
  per connection — nothing is persisted.
- `MODEL` defaults to the highest-quality Opus model. Real-time interpreting is
  latency-sensitive; switch to Haiku/Sonnet via the `MODEL` env var if you need
  faster turnaround.
