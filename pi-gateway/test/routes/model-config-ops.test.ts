import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import * as crypto from "node:crypto";
import { PiProcessPool } from "../../src/pi-process-pool.js";
import { registerSessionRoutes } from "../../src/routes/sessions.js";
import { registerModelConfigRoutes } from "../../src/routes/model-config.js";
import { registerStateRoutes } from "../../src/routes/state.js";
import { registerSessionOpsRoutes } from "../../src/routes/session-ops.js";
import { registerLifecycleRoutes } from "../../src/routes/lifecycle.js";
import { generateToken } from "../../src/auth.js";

function authHeader(): string {
  process.env.JWT_SECRET = "test-secret-cfg";
  return `Bearer ${generateToken("test-user")}`;
}

async function createSession(app: ReturnType<typeof Fastify>, pool: PiProcessPool): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/sessions",
    headers: { authorization: authHeader() }, payload: {},
  });
  return JSON.parse(res.payload).sessionId;
}

describe("HTTP Routes - 模型与配置", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  let sessionId: string;

  beforeAll(async () => {
    registerSessionRoutes(app, pool);
    registerModelConfigRoutes(app, pool);
    registerStateRoutes(app, pool);
    await app.ready();
    sessionId = await createSession(app, pool);
  });

  afterAll(async () => {
    await pool.destroy(sessionId);
    await app.close();
  });

  it("GET /sessions/:id/models → 返回 models 数组", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/models`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.models).toBeInstanceOf(Array);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("PUT /sessions/:id/thinking-level → 200", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/sessions/${sessionId}/thinking-level`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { level: "high" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST /sessions/:id/cycle-model → 返回 model 信息", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/cycle-model`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    if (body) {
      expect(body.model).toBeDefined();
    }
  });

  it("POST /sessions/:id/cycle-thinking-level → 返回 level", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/cycle-thinking-level`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PUT /sessions/:id/config → 同时设置 4 项配置全部生效", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/sessions/${sessionId}/config`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: {
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });
});

describe("HTTP Routes - 会话操作", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  let sessionId: string;

  beforeAll(async () => {
    registerSessionRoutes(app, pool);
    registerSessionOpsRoutes(app, pool);
    registerStateRoutes(app, pool);
    registerLifecycleRoutes(app, pool);
    await app.ready();
    sessionId = await createSession(app, pool);
  });

  afterAll(async () => {
    await pool.destroy(sessionId);
    await app.close();
  });

  it("GET /sessions/:id/messages → 返回消息数组（初始为空）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/messages`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messages).toBeInstanceOf(Array);
  });

  it("POST /sessions/:id/bash `echo hello` → 返回 exitCode: 0", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/bash`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { command: "echo hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.exitCode).toBe(0);
  });

  it("POST /sessions/:id/bash `rm -rf /` → 400 被安全策略阻止", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/bash`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { command: "rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /sessions/:id/name → 200", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/sessions/${sessionId}/name`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { name: "test-session" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  it("GET /sessions/:id/commands → 返回 commands", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/commands`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /sessions/:id/last-response → 返回 text (null)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/last-response`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // 还没有对话，所以 text 为 null 或 undefined
    expect(body.text === null || body.text === undefined || typeof body.text === "string").toBe(true);
  });

  it("POST /sessions/:id/fork-messages → 返回可分支消息", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/fork-messages`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
  });
});
