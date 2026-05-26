import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";

export function registerModelConfigRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.get("/sessions/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "get_available_models" });
    return response.data;
  });

  app.put("/sessions/:id/model", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { provider, modelId } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "set_model", provider, modelId });
    return response.data;
  });

  app.put("/sessions/:id/thinking-level", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { level } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pi.sendCommand({ type: "set_thinking_level", level });
    return { ok: true };
  });

  app.post("/sessions/:id/cycle-model", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "cycle_model" });
    return response.data;
  });

  app.post("/sessions/:id/cycle-thinking-level", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "cycle_thinking_level" });
    return response.data;
  });

  app.put("/sessions/:id/config", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });

    const { steeringMode, followUpMode, autoCompactionEnabled, autoRetryEnabled } = req.body as any;

    if (steeringMode) {
      await pi.sendCommand({ type: "set_steering_mode", mode: steeringMode });
    }
    if (followUpMode) {
      await pi.sendCommand({ type: "set_follow_up_mode", mode: followUpMode });
    }
    if (autoCompactionEnabled !== undefined) {
      await pi.sendCommand({ type: "set_auto_compaction", enabled: autoCompactionEnabled });
    }
    if (autoRetryEnabled !== undefined) {
      await pi.sendCommand({ type: "set_auto_retry", enabled: autoRetryEnabled });
    }

    return { ok: true };
  });
}
