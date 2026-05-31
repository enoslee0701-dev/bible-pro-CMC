// WebSocket message protocol shared (in spirit) between the browser client and
// the Node server. The browser uses a plain-JS copy of these shapes.

// ---- Client -> Server ----------------------------------------------------

export interface TranslateRequest {
  type: "translate";
  // Stable id for this speech segment (assigned by the client).
  id: string;
  // Raw text produced by the browser's speech recognizer (may contain errors).
  text: string;
  sourceLang: string; // BCP-47 code
  targetLang: string; // BCP-47 code
}

// Ask the server to re-examine recent finalized segments and repair any
// recognition / translation errors using the surrounding context.
export interface AutoFixRequest {
  type: "autofix";
  sourceLang: string;
  targetLang: string;
  segments: Array<{ id: string; source: string; translation: string }>;
}

export type ClientMessage = TranslateRequest | AutoFixRequest;

// ---- Server -> Client ----------------------------------------------------

export interface TranslationDelta {
  type: "translation.delta";
  id: string;
  text: string; // incremental chunk of translated text
}

export interface TranslationDone {
  type: "translation.done";
  id: string;
  text: string; // full translated text
}

export interface AutoFixResult {
  type: "autofix.result";
  updates: Array<{
    id: string;
    source: string; // corrected source transcript
    translation: string; // corrected translation
    changed: boolean; // whether the auto-fix actually changed anything
  }>;
}

export interface ServerError {
  type: "error";
  id?: string;
  message: string;
}

export type ServerMessage =
  | TranslationDelta
  | TranslationDone
  | AutoFixResult
  | ServerError;
