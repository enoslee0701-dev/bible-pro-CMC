import Anthropic from "@anthropic-ai/sdk";
import { languageName } from "./languages.js";

const MODEL = process.env.MODEL || "claude-opus-4-8";

// Operating mode is decided at boot:
//   - "ai":   an ANTHROPIC_API_KEY is present -> Claude translation + auto-fix.
//   - "free": no key (or TRANSLATOR=free) -> keyless public machine translation,
//             AI auto-fix disabled.
export const MODE: "ai" | "free" =
  process.env.ANTHROPIC_API_KEY && process.env.TRANSLATOR !== "free"
    ? "ai"
    : "free";
export const AUTOFIX_AVAILABLE = MODE === "ai";

// A short rolling memory of recent finalized segments, kept per source/target
// pair so the translator (and the auto-fixer) have conversational context.
export interface ContextSegment {
  source: string;
  translation: string;
}

export interface TranslateParams {
  text: string;
  sourceLang: string;
  targetLang: string;
  context: ContextSegment[];
}

/**
 * Translate one finalized speech segment, calling `onDelta` with incremental
 * text. Dispatches to Claude (AI mode) or the free provider (free mode).
 */
export async function translate(
  params: TranslateParams,
  onDelta: (chunk: string) => void,
): Promise<string> {
  return MODE === "ai"
    ? translateWithClaude(params, onDelta)
    : translateFree(params, onDelta);
}

// ---- AI mode (Claude) ----------------------------------------------------

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Constructed lazily so free mode never needs an API key.
  if (!client) client = new Anthropic();
  return client;
}

function translatorSystemPrompt(sourceName: string, targetName: string): string {
  return [
    `You are an elite simultaneous interpreter translating live speech from ${sourceName} into ${targetName}.`,
    "",
    "The input is the raw output of an automatic speech recognizer, so it may contain:",
    "- homophone errors and mis-recognized words,",
    "- missing or wrong punctuation,",
    "- run-on fragments with no sentence boundaries.",
    "",
    "Before translating, silently reconstruct what the speaker most likely meant",
    "using the surrounding context, then render a fluent, faithful, natural-sounding",
    `translation in ${targetName}.`,
    "",
    "Rules:",
    `- Output ONLY the ${targetName} translation. No quotes, no explanations, no notes.`,
    "- Preserve the speaker's tone and register.",
    "- Keep proper nouns, numbers and technical terms accurate.",
    "- If the fragment is incomplete, translate it as-is without inventing content.",
  ].join("\n");
}

function buildContextBlock(context: ContextSegment[]): string {
  if (context.length === 0) return "";
  const lines = context
    .map((c) => `- ${c.source}  ->  ${c.translation}`)
    .join("\n");
  return `Recent context (already interpreted, for continuity only — do not re-translate):\n${lines}\n\n`;
}

async function translateWithClaude(
  params: TranslateParams,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const sourceName = languageName(params.sourceLang);
  const targetName = languageName(params.targetLang);

  const contextBlock = buildContextBlock(params.context);
  const userContent =
    `${contextBlock}Interpret this new ${sourceName} speech segment into ${targetName}:\n\n` +
    params.text;

  let full = "";
  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: 1024,
    // Real-time path: we want the translation immediately, not a reasoning pass.
    thinking: { type: "disabled" },
    system: [
      {
        type: "text",
        text: translatorSystemPrompt(sourceName, targetName),
        // Stable across every segment in the session -> cache it.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  stream.on("text", (delta) => {
    full += delta;
    onDelta(delta);
  });

  await stream.finalMessage();
  return full.trim();
}

// ---- Free mode (keyless public translation via MyMemory) -----------------

const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
// Optional: setting MYMEMORY_EMAIL raises the anonymous daily quota.
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL;

// Map our BCP-47 codes to what MyMemory expects: keep Chinese regional variants,
// use the bare ISO-639-1 primary subtag for everything else.
function mymemoryCode(code: string): string {
  return code.startsWith("zh") ? code : code.split("-")[0];
}

// MyMemory caps an anonymous query at ~500 bytes; split long segments on
// sentence punctuation, hard-slicing anything still oversized.
function chunkText(text: string, max = 450): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];

  const pieces = trimmed.split(/(?<=[。！？!?.\n])/);
  const out: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (piece.length > max) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max));
    } else if ((cur + piece).length > max) {
      if (cur) out.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

async function freeTranslateChunk(
  text: string,
  src: string,
  tgt: string,
): Promise<string> {
  const qs = new URLSearchParams({ q: text, langpair: `${src}|${tgt}` });
  if (MYMEMORY_EMAIL) qs.set("de", MYMEMORY_EMAIL);

  const res = await fetch(`${MYMEMORY_ENDPOINT}?${qs.toString()}`, {
    headers: { "User-Agent": "ai-simultaneous-interpreter/1.0" },
  });
  if (!res.ok) throw new Error(`免费翻译服务返回 ${res.status}（请稍后重试或配置 API 密钥）`);

  const data = (await res.json()) as {
    responseStatus?: number | string;
    responseDetails?: string;
    responseData?: { translatedText?: string };
  };

  const status = Number(data.responseStatus);
  if (status !== 200) {
    throw new Error(data.responseDetails || "免费翻译服务暂时不可用（可能已达每日额度）");
  }
  return (data.responseData?.translatedText || "").trim();
}

async function translateFree(
  params: TranslateParams,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const src = mymemoryCode(params.sourceLang);
  const tgt = mymemoryCode(params.targetLang);

  const parts: string[] = [];
  for (const chunk of chunkText(params.text)) {
    parts.push(await freeTranslateChunk(chunk, src, tgt));
  }
  const full = parts.join(" ").trim();
  // The free provider isn't streaming; emit the whole result as one update so
  // the client's rendering path stays identical to AI mode.
  onDelta(full);
  return full;
}

// ---- AI auto-fix (AI mode only) ------------------------------------------

export interface AutoFixSegment {
  id: string;
  source: string;
  translation: string;
}

export interface AutoFixUpdate {
  id: string;
  source: string;
  translation: string;
  changed: boolean;
}

/**
 * Re-examine a window of recent segments together and repair recognition /
 * translation errors that only become obvious with the full context.
 * Returns a corrected source transcript and translation for each segment.
 * No-op in free mode.
 */
export async function autoFixSegments(params: {
  segments: AutoFixSegment[];
  sourceLang: string;
  targetLang: string;
}): Promise<AutoFixUpdate[]> {
  const { segments } = params;
  if (MODE !== "ai" || segments.length === 0) return [];

  const sourceName = languageName(params.sourceLang);
  const targetName = languageName(params.targetLang);

  const system = [
    `You are a meticulous bilingual (${sourceName} / ${targetName}) proofreader for a live`,
    "simultaneous-interpretation feed. You receive consecutive segments where the",
    `${sourceName} side came from imperfect speech recognition and the ${targetName} side`,
    "was translated segment-by-segment without full context.",
    "",
    "Using the whole window as context, for EACH segment:",
    `1. Correct the ${sourceName} transcript: fix homophones, mis-recognitions, word`,
    "   boundaries and punctuation so it reads as what was actually said.",
    `2. Provide an improved, fluent ${targetName} translation consistent across segments`,
    "   (consistent terminology, correct pronouns, fixed earlier mistakes).",
    "",
    "Preserve meaning — never invent content that was not spoken. If a segment is already",
    "correct, return it unchanged.",
  ].join("\n");

  const payload = segments
    .map(
      (s, i) =>
        `[${i + 1}] id=${s.id}\n  ${sourceName}: ${s.source}\n  ${targetName}: ${s.translation}`,
    )
    .join("\n\n");

  const instructions =
    `Proofread and repair these ${segments.length} segments. Return EVERY segment, ` +
    "preserving its exact id.\n\n" +
    "Respond with ONLY a JSON object (no markdown, no prose) of the shape:\n" +
    '{"segments":[{"id":"...","source":"<corrected source>","translation":"<corrected translation>"}]}\n\n' +
    payload;

  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "disabled" },
    system,
    messages: [{ role: "user", content: instructions }],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];

  const parsed = parseJsonObject(textBlock.text);
  if (!parsed) return [];

  const byId = new Map<string, AutoFixSegment>(segments.map((s) => [s.id, s]));
  const updates: AutoFixUpdate[] = [];
  for (const fixed of parsed.segments ?? []) {
    const original = byId.get(fixed.id);
    if (!original) continue;
    const source = (fixed.source ?? "").trim();
    const translation = (fixed.translation ?? "").trim();
    if (!source && !translation) continue;
    const changed =
      source !== original.source.trim() ||
      translation !== original.translation.trim();
    updates.push({ id: fixed.id, source, translation, changed });
  }
  return updates;
}

interface AutoFixResponse {
  segments?: Array<{ id: string; source: string; translation: string }>;
}

// Tolerant JSON extraction: handles a bare object or one wrapped in ```json``` /
// surrounding prose by slicing from the first "{" to the last "}".
function parseJsonObject(text: string): AutoFixResponse | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as AutoFixResponse;
  } catch {
    return null;
  }
}
