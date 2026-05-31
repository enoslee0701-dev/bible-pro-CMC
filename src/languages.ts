// Supported languages. `code` is the BCP-47 tag handed to the browser's
// SpeechRecognition / SpeechSynthesis engines; `name` is the human-readable
// label passed to Claude in the prompt.
export interface Language {
  code: string;
  name: string;
  label: string;
}

export const LANGUAGES: Language[] = [
  { code: "zh-CN", name: "Simplified Chinese", label: "中文（简体）" },
  { code: "zh-TW", name: "Traditional Chinese", label: "中文（繁體）" },
  { code: "en-US", name: "English", label: "English" },
  { code: "ja-JP", name: "Japanese", label: "日本語" },
  { code: "ko-KR", name: "Korean", label: "한국어" },
  { code: "es-ES", name: "Spanish", label: "Español" },
  { code: "fr-FR", name: "French", label: "Français" },
  { code: "de-DE", name: "German", label: "Deutsch" },
  { code: "ru-RU", name: "Russian", label: "Русский" },
  { code: "pt-BR", name: "Portuguese", label: "Português" },
  { code: "it-IT", name: "Italian", label: "Italiano" },
  { code: "ar-SA", name: "Arabic", label: "العربية" },
  { code: "hi-IN", name: "Hindi", label: "हिन्दी" },
  { code: "th-TH", name: "Thai", label: "ไทย" },
  { code: "vi-VN", name: "Vietnamese", label: "Tiếng Việt" },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function languageName(code: string): string {
  return BY_CODE.get(code)?.name ?? code;
}
