import Anthropic from "@anthropic-ai/sdk";
import { languageName } from "./languages.js";

const MODEL = process.env.MODEL || "claude-opus-4-8";

const client = new Anthropic();

// A short rolling memory of recent finalized segments, kept per source/target
// pair so the translator (and the auto-fixer) have conversational context.
export interface ContextSegment {
  source: string;
  translation: string;
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

/**
 * Stream a translation for a single finalized speech segment.
 * Calls `onDelta` with incremental text and resolves with the full translation.
 */
export async function translateSegment(
  params: {
    text: string;
    sourceLang: string;
    targetLang: string;
    context: ContextSegment[];
  },
  onDelta: (chunk: string) => void,
): Promise<string> {
  const sourceName = languageName(params.sourceLang);
  const targetName = languageName(params.targetLang);

  const contextBlock = buildContextBlock(params.context);
  const userContent =
    `${contextBlock}Interpret this new ${sourceName} speech segment into ${targetName}:\n\n` +
    params.text;

  let full = "";
  const stream = client.messages.stream({
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
 */
export async function autoFixSegments(params: {
  segments: AutoFixSegment[];
  sourceLang: string;
  targetLang: string;
}): Promise<AutoFixUpdate[]> {
  const { segments } = params;
  if (segments.length === 0) return [];

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

  const stream = client.messages.stream({
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
