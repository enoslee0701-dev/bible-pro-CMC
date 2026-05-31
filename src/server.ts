import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LANGUAGES } from "./languages.js";
import {
  translateSegment,
  autoFixSegments,
  type ContextSegment,
} from "./interpreter.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[warn] ANTHROPIC_API_KEY is not set — translation calls will fail. " +
      "Copy .env.example to .env and add your key.",
  );
}

const app = express();
app.use(express.static(join(__dirname, "..", "public")));

// Expose the language list so the client and server never drift apart.
app.get("/api/languages", (_req, res) => {
  res.json(LANGUAGES);
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on("connection", (ws) => {
  // Per-connection rolling context: the last few interpreted segments, used to
  // give the translator and auto-fixer continuity.
  const recent: ContextSegment[] = [];
  const MAX_CONTEXT = 6;

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Malformed message" });
      return;
    }

    if (msg.type === "translate") {
      try {
        const translation = await translateSegment(
          {
            text: msg.text,
            sourceLang: msg.sourceLang,
            targetLang: msg.targetLang,
            context: recent.slice(-MAX_CONTEXT),
          },
          (chunk) => send(ws, { type: "translation.delta", id: msg.id, text: chunk }),
        );

        send(ws, { type: "translation.done", id: msg.id, text: translation });

        recent.push({ source: msg.text, translation });
        if (recent.length > 20) recent.shift();
      } catch (err) {
        console.error("translate error:", err);
        send(ws, {
          type: "error",
          id: msg.id,
          message: errorMessage(err),
        });
      }
      return;
    }

    if (msg.type === "autofix") {
      try {
        const updates = await autoFixSegments({
          segments: msg.segments,
          sourceLang: msg.sourceLang,
          targetLang: msg.targetLang,
        });

        send(ws, {
          type: "autofix.result",
          updates: updates.map((u) => ({
            id: u.id,
            source: u.source,
            translation: u.translation,
            changed: u.changed,
          })),
        });
      } catch (err) {
        console.error("autofix error:", err);
        send(ws, { type: "error", message: errorMessage(err) });
      }
      return;
    }

    send(ws, { type: "error", message: "Unknown message type" });
  });
});

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unknown server error";
}

httpServer.listen(PORT, () => {
  console.log(`\n  AI Simultaneous Interpreter running at http://localhost:${PORT}\n`);
});
