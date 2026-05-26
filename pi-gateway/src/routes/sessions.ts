import type { FastifyInstance } from "fastify";
import * as crypto from "node:crypto";
import { validateCwd } from "../security.js";
import type { PiProcessPool } from "../pi-process-pool.js";
import { collectEvent } from "../metrics.js";

const sessionCreateSchema = {
  type: "object",
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    noSession: { type: "boolean" },
    sessionDir: { type: "string" },
    thinkingLevel: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

export function registerSessionRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.post("/sessions", { schema: { body: sessionCreateSchema } }, async (req, reply) => {
    const { provider, model, cwd, noSession, sessionDir, thinkingLevel } = req.body as any;

    if (cwd) {
      try { validateCwd(cwd); } catch (e: any) {
        return reply.code(400).send({ error: e.message });
      }
    }

    const sessionId = "sess_" + crypto.randomUUID().slice(0, 12);

    try {
      await pool.create(sessionId, { provider, model, cwd, noSession, sessionDir, thinkingLevel });
    } catch (e: any) {
      return reply.code(503).send({ error: "Unable to create session" });
    }

    collectEvent(pool.recentEvents, "created", sessionId, `provider=${provider ?? "-"} model=${model ?? "-"}`);
    return reply.code(201).send({ sessionId, status: "ready" });
  });

  app.delete("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pool.destroy(id, "explicit delete");
    return { ok: true };
  });
}
