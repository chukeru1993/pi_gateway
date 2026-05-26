import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import * as crypto from "node:crypto";
import { PiProcessPool } from "../../src/pi-process-pool.js";
import { registerSessionRoutes } from "../../src/routes/sessions.js";
import { registerStateRoutes } from "../../src/routes/state.js";
import { generateToken } from "../../src/auth.js";

function authHeader(): string {
  process.env.JWT_SECRET = "test-secret-456";
  return `Bearer ${generateToken("test-user")}`;
}

describe("HTTP Routes - 会话管理", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  const createdSessions: string[] = [];

  beforeAll(async () => {
    registerSessionRoutes(app, pool);
    registerStateRoutes(app, pool);
    await app.ready();
  });

  afterAll(async () => {
    for (const id of createdSessions) {
      await pool.destroy(id);
    }
    await app.close();
  });

  it("POST /sessions → 201 + sessionId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: authHeader() },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.sessionId).toMatch(/^sess_/);
    expect(body.status).toBe("ready");
    createdSessions.push(body.sessionId);
  });

  it("POST /sessions with cwd → 201（不传 cwd 时 spawn 在当前目录）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: authHeader() },
      payload: { model: "deepseek-v4-flash" },
    });
    expect(res.statusCode).toBe(201);
    createdSessions.push(JSON.parse(res.payload).sessionId);
  });

  it("GET /sessions/:id/state → 包含 model/thinkingLevel 等字段", async () => {
    // 使用已创建的会话
    const sid = createdSessions[0];
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sid}/state`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.model).toBeDefined();
    expect(typeof body.thinkingLevel).toBe("string");
    expect(typeof body.isStreaming).toBe("boolean");
    expect(typeof body.messageCount).toBe("number");
  });

  it("GET /sessions/:id/stats → 返回 session stats", async () => {
    const sid = createdSessions[0];
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sid}/stats`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessionFile || body.sessionId).toBeDefined();
  });

  it("DELETE /sessions/:id → 200 + 进程退出", async () => {
    const sid = createdSessions[0];
    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/${sid}`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);

    // 删除后再查 state → 404
    const res2 = await app.inject({
      method: "GET",
      url: `/sessions/${sid}/state`,
      headers: { authorization: authHeader() },
    });
    expect(res2.statusCode).toBe(404);

    // 从 createdSessions 中移除
    createdSessions.splice(0, 1);
  });

  it("GET /sessions/:id/state → 404 对不存在会话", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/sessions/nonexistent/state",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(404);
  });
});
