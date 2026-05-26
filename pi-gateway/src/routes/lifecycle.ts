import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";

export function registerLifecycleRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.post("/sessions/:id/new-session", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { parentSession } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "new_session", parentSession });
    return response.data;
  });

  app.post("/sessions/:id/switch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sessionPath } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "switch_session", sessionPath });
    return response.data;
  });

  app.post("/sessions/:id/fork", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { entryId } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "fork", entryId });
    return response.data;
  });

  app.post("/sessions/:id/clone", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "clone" });
    return response.data;
  });

  app.get("/sessions/:id/fork-messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "get_fork_messages" });
    return response.data;
  });
}
