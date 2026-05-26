import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { PiProcessPool } from "../../src/pi-process-pool.js";
import { registerSessionRoutes } from "../../src/routes/sessions.js";
import { registerChatRoutes } from "../../src/routes/chat.js";
import { registerUiResponseRoutes } from "../../src/routes/ui-response.js";
import { generateToken } from "../../src/auth.js";

function authHeader(): string {
  process.env.JWT_SECRET = "test-secret-789";
  return `Bearer ${generateToken("test-user")}`;
}

async function createSession(app: ReturnType<typeof Fastify>, pool: PiProcessPool): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: authHeader(), "content-type": "application/json" },
    payload: {},
  });
  return JSON.parse(res.payload).sessionId;
}

describe("HTTP Routes - Chat SSE", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  let sessionId: string;

  beforeAll(async () => {
    registerSessionRoutes(app, pool);
    registerChatRoutes(app, pool);
    registerUiResponseRoutes(app, pool);
    await app.ready();
    sessionId = await createSession(app, pool);
  });

  afterAll(async () => {
    await pool.destroy(sessionId);
    await app.close();
  });

  it.skip("POST /sessions/:id/chat → 200 + Content-Type: text/event-stream (需要真实 HTTP 客户端；inject 不支持 SSE 流测试)", { timeout: 5000 }, async () => {
    // SSE 流通过 reply.raw.writeHead 写入，Fastify inject 会等 response end
    // 才能返回，导致超时。SSE 流行为需要通过 curl/fetch 测试。
    // 这里验证路由注册正确 (chat 请求缺少 message → 400 已验证 schema)
  });

  it.skip("POST /sessions/:id/chat 已占用时 409 (需要真实 HTTP 客户端)", { timeout: 5000 }, async () => {
    // 同上，SSE inject 不支持并发连接测试
  });

  it("POST /sessions/:id/steer → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/steer`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { message: "Focus on the task" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  it("POST /sessions/:id/follow-up → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/follow-up`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { message: "Also check the logs" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  it("POST /sessions/:id/abort → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/abort`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
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

describe("HTTP Routes - UI Response / Pending", () => {
  const app = Fastify({ logger: false });
  const pool = new PiProcessPool();
  let sessionId: string;

  beforeAll(async () => {
    registerSessionRoutes(app, pool);
    registerChatRoutes(app, pool);
    registerUiResponseRoutes(app, pool);
    await app.ready();
    sessionId = await createSession(app, pool);
  });

  afterAll(async () => {
    await pool.destroy(sessionId);
    await app.close();
  });

  it("GET /sessions/:id/pending-ui-requests → 无 pending 时返回空数组", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/pending-ui-requests`,
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.questions).toEqual([]);
  });

  it("POST /sessions/:id/ui-response → 400 缺少必需字段", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/ui-response`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { id: "no-response-field" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /sessions/:id/ui-response confirm → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/ui-response`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { id: "test-q-1", confirmed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  it("POST /sessions/:id/ui-response value → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/ui-response`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { id: "test-q-2", value: "Allow" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  it("POST /sessions/:id/ui-response cancelled → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/ui-response`,
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: { id: "test-q-3", cancelled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });
});
