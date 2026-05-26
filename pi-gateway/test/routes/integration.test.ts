import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import * as os from "node:os";
import { PiProcessPool } from "../../src/pi-process-pool.js";
import { registerSessionRoutes } from "../../src/routes/sessions.js";
import { registerStateRoutes } from "../../src/routes/state.js";
import { registerChatRoutes } from "../../src/routes/chat.js";
import { registerUiResponseRoutes } from "../../src/routes/ui-response.js";
import { registerModelConfigRoutes } from "../../src/routes/model-config.js";
import { registerSessionOpsRoutes } from "../../src/routes/session-ops.js";
import { registerLifecycleRoutes } from "../../src/routes/lifecycle.js";
import { authHook, generateToken } from "../../src/auth.js";

function authHeader(): string {
  process.env.JWT_SECRET = "test-secret-integration";
  return `Bearer ${generateToken("test-user")}`;
}

async function createSession(app: ReturnType<typeof Fastify>, pool: PiProcessPool): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/sessions",
    headers: { authorization: authHeader(), "content-type": "application/json" },
    payload: {},
  });
  return JSON.parse(res.payload).sessionId;
}

const MAX_TOTAL_PROCESSES = 50;

describe("Integration - 完整对话流程", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  let sessionId: string;

  beforeAll(async () => {
    // Register health (no auth)
    app.get("/health", async () => {
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      return {
        status: "ok",
        activeSessions: pool.size,
        maxSessions: MAX_TOTAL_PROCESSES,
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        systemMemoryPercent: Math.round((usedMem / totalMem) * 100),
      };
    });

    // Register auth hook for all other routes
    app.addHook("preHandler", async (req, reply) => {
      if ((req.routeOptions.url || req.url) === "/health") return;
      try {
        await authHook(req as any);
      } catch (e: any) {
        reply.code(e.statusCode || 401).send({ error: e.message });
      }
    });

    registerSessionRoutes(app, pool);
    registerStateRoutes(app, pool);
    registerChatRoutes(app, pool);
    registerUiResponseRoutes(app, pool);
    registerModelConfigRoutes(app, pool);
    registerSessionOpsRoutes(app, pool);
    registerLifecycleRoutes(app, pool);
    await app.ready();

    sessionId = await createSession(app, pool);
  });

  afterAll(async () => {
    await pool.destroy(sessionId);
    await app.close();
  });

  it("创建会话 → 验证初始状态", { timeout: 10000 }, async () => {
    const stateRes = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/state`,
      headers: { authorization: authHeader() },
    });
    expect(stateRes.statusCode).toBe(200);
    const state = JSON.parse(stateRes.payload);
    expect(state.messageCount).toBe(0);
    expect(state.isStreaming).toBe(false);
    expect(state.model).toBeDefined();
  });

  it("切换模型后 GET /state 中 model 变化", { timeout: 15000 }, async () => {
    const stateBefore = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/state`,
      headers: { authorization: authHeader() },
    });
    const modelBefore = JSON.parse(stateBefore.payload).model?.id;

    const modelsRes = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/models`,
      headers: { authorization: authHeader() },
    });
    const { models } = JSON.parse(modelsRes.payload);
    if (models.length < 2) return;

    const targetModel = models.find((m: any) => m.id !== modelBefore);
    if (targetModel) {
      const setModelRes = await app.inject({
        method: "PUT",
        url: `/sessions/${sessionId}/model`,
        headers: { authorization: authHeader(), "content-type": "application/json" },
        payload: { provider: targetModel.provider, modelId: targetModel.id },
      });
      expect(setModelRes.statusCode).toBe(200);

      const stateAfter = await app.inject({
        method: "GET",
        url: `/sessions/${sessionId}/state`,
        headers: { authorization: authHeader() },
      });
      const stateAfterBody = JSON.parse(stateAfter.payload);
      expect(stateAfterBody.model?.id).toBe(targetModel.id);
    }
  });

  it("PUT /sessions/:id/config 批量配置后状态反映变化", async () => {
    await app.inject({
      method: "PUT",
      url: `/sessions/${sessionId}/config`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: {
        steeringMode: "all",
        followUpMode: "all",
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
      },
    });

    const stateRes = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/state`,
      headers: { authorization: authHeader() },
    });
    const state = JSON.parse(stateRes.payload);
    expect(state.steeringMode).toBe("all");
    expect(state.followUpMode).toBe("all");
    expect(state.autoCompactionEnabled).toBe(false);
  });

  it("POST /sessions/:id/bash 执行命令", { timeout: 10000 }, async () => {
    const bashRes = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/bash`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { command: "echo integration-test" },
    });
    expect(bashRes.statusCode).toBe(200);
    const body = JSON.parse(bashRes.payload);
    expect(body.exitCode).toBe(0);
  });

  it("无 token 访问业务端点 → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/state`,
      headers: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("无 token 访问 /health → 200（白名单）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
  });

  it("chat 请求缺少 message 字段 → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/chat`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
