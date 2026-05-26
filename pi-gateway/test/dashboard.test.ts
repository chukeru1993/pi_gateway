import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import * as crypto from "node:crypto";
import { PiProcessPool } from "../src/pi-process-pool.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import { generateToken } from "../src/auth.js";

function authHeader(): string {
  process.env.JWT_SECRET = "test-secret-admin";
  return `Bearer ${generateToken("test-user")}`;
}

describe("Admin Dashboard", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  const maxSessions = 50;
  const createdSessions: string[] = [];

  beforeAll(async () => {
    registerSessionRoutes(app, pool);
    await app.ready();

    // 创建一个会话用于 admin 面板展示
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: authHeader() },
      payload: {},
    });
    createdSessions.push(JSON.parse(res.payload).sessionId);
  });

  afterAll(async () => {
    for (const id of createdSessions) {
      await pool.destroy(id);
    }
    await app.close();
  });

  it("GET /admin → 返回 HTML (Content-Type: text/html)", async () => {
    // 将 admin 注册在 app 上
    const adminApp = Fastify({ logger: false });
    registerAdminRoutes(adminApp, pool, maxSessions);
    await adminApp.ready();

    const res = await adminApp.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.payload).toContain("<!DOCTYPE html>");
    expect(res.payload).toContain("pi Gateway Admin");

    await adminApp.close();
  });

  it("GET /admin/api/metrics → 返回正确 JSON 数据", async () => {
    const adminApp = Fastify({ logger: false });
    registerAdminRoutes(adminApp, pool, maxSessions);
    await adminApp.ready();

    const res = await adminApp.inject({
      method: "GET",
      url: "/admin/api/metrics",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.activeSessions).toBeGreaterThanOrEqual(1);
    expect(body.maxSessions).toBe(maxSessions);
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.gatewayMemoryMB).toBe("number");
    expect(body.events).toBeInstanceOf(Array);

    await adminApp.close();
  });

  it("GET /admin/api/sessions → 返回会话列表", async () => {
    const adminApp = Fastify({ logger: false });
    registerAdminRoutes(adminApp, pool, maxSessions);
    await adminApp.ready();

    const res = await adminApp.inject({
      method: "GET",
      url: "/admin/api/sessions",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessions).toBeInstanceOf(Array);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);

    const session = body.sessions[0];
    expect(session.sessionId).toBeDefined();
    expect(session.status).toMatch(/^(idle|streaming|compacting)$/);
    expect(typeof session.model).toBe("string");
    expect(typeof session.messageCount).toBe("number");
    expect(typeof session.memoryMB).toBe("number");

    await adminApp.close();
  });

  it("GET /admin/api/sessions/:id → 返回单个会话详情", async () => {
    const adminApp = Fastify({ logger: false });
    registerAdminRoutes(adminApp, pool, maxSessions);
    await adminApp.ready();

    const res = await adminApp.inject({
      method: "GET",
      url: `/admin/api/sessions/${createdSessions[0]}`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessionId).toBe(createdSessions[0]);
    expect(body.status).toMatch(/^(idle|streaming|compacting)$/);

    await adminApp.close();
  });

  it("GET /admin/api/sessions/:id → 404 不存在", async () => {
    const adminApp = Fastify({ logger: false });
    registerAdminRoutes(adminApp, pool, maxSessions);
    await adminApp.ready();

    const res = await adminApp.inject({
      method: "GET",
      url: "/admin/api/sessions/nonexistent",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(404);

    await adminApp.close();
  });
});
