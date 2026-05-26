import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";
import { validateBash } from "../security.js";

const bashSchema = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", minLength: 1 },
  },
} as const;

export function registerSessionOpsRoutes(app: FastifyInstance, pool: PiProcessPool) {
  app.get("/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "get_messages" });
    return response.data;
  });

  app.post("/sessions/:id/compact", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { customInstructions } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "compact", customInstructions });
    return response.data;
  });

  app.post("/sessions/:id/bash", { schema: { body: bashSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { command } = req.body as any;

    try { validateBash(command); } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "bash", command });
    return response.data;
  });

  app.post("/sessions/:id/abort-bash", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pi.sendCommand({ type: "abort_bash" });
    return { ok: true };
  });

  app.get("/sessions/:id/commands", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "get_commands" });
    return response.data;
  });

  app.put("/sessions/:id/name", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    await pi.sendCommand({ type: "set_session_name", name });
    return { ok: true };
  });

  app.get("/sessions/:id/last-response", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "get_last_assistant_text" });
    return response.data;
  });

  app.post("/sessions/:id/export-html", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { outputPath } = req.body as any;
    const pi = pool.get(id);
    if (!pi) return reply.code(404).send({ error: "Session not found" });
    const response = await pi.sendCommand({ type: "export_html", outputPath });
    return response.data;
  });
}
