import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";

export function registerStateRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.get("/sessions/:id/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });

    const response = await pi.sendCommand({ type: "get_state" });
    return response.data;
  });

  app.get("/sessions/:id/stats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });

    const response = await pi.sendCommand({ type: "get_session_stats" });
    return response.data;
  });
}
