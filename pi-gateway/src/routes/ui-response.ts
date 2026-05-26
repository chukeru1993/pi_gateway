import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";

const uiResponseSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    confirmed: { type: "boolean" },
    value: { type: "string" },
    cancelled: { type: "boolean" },
  },
  oneOf: [
    { required: ["confirmed"] },
    { required: ["value"] },
    { required: ["cancelled"] },
  ],
} as const;

export function registerUiResponseRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.post("/sessions/:id/ui-response", { schema: { body: uiResponseSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });

    const { id: requestId, confirmed, value, cancelled } = req.body as any;

    if (cancelled) {
      pi.sendUiResponse(requestId, { cancelled: true });
    } else if (confirmed !== undefined) {
      pi.sendUiResponse(requestId, { confirmed });
    } else if (value !== undefined) {
      pi.sendUiResponse(requestId, { value });
    } else {
      return reply.code(400).send({ error: "Must provide confirmed, value, or cancelled" });
    }

    pi.removePendingQuestion(requestId);
    return { ok: true };
  });

  app.get("/sessions/:id/pending-ui-requests", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const questions = pi.getPendingUiRequests();
    return { questions };
  });
}
