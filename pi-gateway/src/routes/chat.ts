import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";
import { createSSEWriter } from "../sse-writer.js";
import { collectEvent } from "../metrics.js";

const chatSchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 },
    images: { type: "array" },
    streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
  },
} as const;

export function registerChatRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.post("/sessions/:id/chat", { schema: { body: chatSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { message, images, streamingBehavior } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    if (pi.activeSSEs.size > 0) {
      if (pi.isStreaming) {
        return reply.code(409).send({ error: "Session already has an active chat connection" });
      }
      for (const oldSse of pi.activeSSEs) {
        (oldSse as any).end();
      }
      pi.activeSSEs.clear();
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    });

    const sse = createSSEWriter(reply.raw);
    pi.activeSSEs.add(sse);

    let streamResolve: () => void = () => {};
    const streamDone = new Promise<void>((r) => { streamResolve = r; });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(safetyTimer);
      unsubscribe();
      pi.activeSSEs.delete(sse);
      sse.end();
      pi.resetIdleTimer();
      streamResolve();
    };

    const STREAM_TIMEOUT = 10 * 60 * 1000; // 10 minutes safety timeout
    const safetyTimer = setTimeout(() => {
      sse.write("error", { message: "Stream timed out" });
      cleanup();
    }, STREAM_TIMEOUT);

    const unsubscribe = pi.onEvent((event) => {
      pi.resetIdleTimer();

      if (event.type === "error") {
        sse.write("error", { message: event.message });
        cleanup();
        return;
      }

      if (event.type === "extension_ui_request") {
        switch (event.method) {
          case "select":
          case "confirm":
          case "input":
          case "editor": {
            const question = {
              id: event.id,
              method: event.method,
              title: event.title,
              message: event.message,
              options: event.options,
              placeholder: event.placeholder,
              prefill: event.prefill,
              timeout: event.timeout,
            };
            pi.registerPendingQuestion(question);
            sse.write("user_question", question);
            return;
          }
          case "notify":
            sse.write("notification", {
              id: event.id,
              message: event.message,
              notifyType: event.notifyType || "info",
            });
            return;
          case "setStatus":
            sse.write("status_update", {
              id: event.id,
              statusKey: event.statusKey,
              statusText: event.statusText,
            });
            return;
          case "setWidget":
            sse.write("widget_update", {
              id: event.id,
              widgetKey: event.widgetKey,
              widgetLines: event.widgetLines,
              widgetPlacement: event.widgetPlacement,
            });
            return;
          case "setTitle":
            sse.write("title_update", {
              id: event.id,
              title: event.title,
            });
            return;
          case "set_editor_text":
            sse.write("editor_text_update", {
              id: event.id,
              text: event.text,
            });
            return;
          default:
            return;
        }
      }

      if (event.type === "agent_end") {
        sse.write("agent_end", event);
        cleanup();
        return;
      }

      sse.write(event.type, event);
    });

    req.raw.on("close", () => {
      cleanup();
    });

    try {
      pool.promptsSent++;
      collectEvent(pool.recentEvents, "prompt", id, message.slice(0, 50));
      await pi.sendCommand({ type: "prompt", message, images, streamingBehavior });
    } catch (err: any) {
      pool.errorsCount++;
      sse.write("error", { message: err.message });
      cleanup();
      return;
    }

    await streamDone;
  });

  app.post("/sessions/:id/steer", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { message, images } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pi.sendCommand({ type: "steer", message, images });
    return { ok: true };
  });

  app.post("/sessions/:id/follow-up", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { message, images } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pi.sendCommand({ type: "follow_up", message, images });
    return { ok: true };
  });

  app.post("/sessions/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pi.sendCommand({ type: "abort" });
    return { ok: true };
  });
}
