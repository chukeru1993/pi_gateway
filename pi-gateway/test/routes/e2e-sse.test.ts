import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { generateToken } from "../../src/auth.js";

process.env.JWT_SECRET = "e2e-secret-key";
const TOKEN = generateToken("e2e-test-user");

let gatewayProcess: ChildProcess | null = null;
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;

function startGateway(): Promise<void> {
  return new Promise((resolve, reject) => {
    gatewayProcess = spawn("node", ["dist/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        JWT_SECRET: "e2e-secret-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        gatewayProcess?.kill();
        reject(new Error("Gateway failed to start within 10s"));
      }
    }, 10000);

    gatewayProcess.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("listening on port")) {
        started = true;
        clearTimeout(timeout);
        setTimeout(resolve, 500); // 等一会确保 ready
      }
    });
    gatewayProcess.stderr?.on("data", (d: Buffer) => {});
    gatewayProcess.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Gateway exited with code ${code}`));
      }
    });
  });
}

async function stopGateway(): Promise<void> {
  if (gatewayProcess) {
    gatewayProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (!gatewayProcess?.killed) {
      gatewayProcess?.kill("SIGKILL");
    }
  }
}

describe("E2E - SSE 流测试", () => {
  beforeAll(async () => {
    await startGateway();
  }, 15000);

  afterAll(async () => {
    await stopGateway();
  });

  it("GET /health → 200", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
  });

  it("POST /sessions → 201", async () => {
    const res = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.sessionId).toMatch(/^sess_/);
    expect(body.status).toBe("ready");
  });

  it("无 token 访问 → 401", async () => {
    const res = await fetch(`${BASE}/sessions`);
    expect(res.status).toBe(401);
  });

  it("POST /sessions/:id/bash → 执行成功", { timeout: 15000 }, async () => {
    const createRes = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json() as any;

    const bashRes = await fetch(`${BASE}/sessions/${sessionId}/bash`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ command: "echo e2e-test" }),
    });
    expect(bashRes.status).toBe(200);
    const body = await bashRes.json() as any;
    expect(body.exitCode).toBe(0);
    expect(body.output || "").toContain("e2e-test");

    // Cleanup
    await fetch(`${BASE}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }, 15000);

  it("POST /sessions/:id/chat SSE 流 → 收到 agent_* 事件", { timeout: 60000 }, async () => {
    const createRes = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json() as any;

    // 启动 SSE chat
    const chatRes = await fetch(`${BASE}/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ message: "Say exactly: e2e-ok" }),
    });

    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get("content-type")).toContain("text/event-stream");

    // 解析 SSE 流
    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const eventTypes = new Set<string>();
    let textDeltaCount = 0;
    let gotAgentStart = false;
    let gotAgentEnd = false;

    const startTime = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          const event = line.slice(7);
          eventTypes.add(event);
          if (event === "agent_start") gotAgentStart = true;
          if (event === "agent_end") {
            gotAgentEnd = true;
            reader.cancel();
          }
        } else if (line.startsWith("data: ")) {
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.assistantMessageEvent?.type === "text_delta") {
              textDeltaCount++;
            }
          } catch {}
        }
      }

      if (gotAgentEnd) break;
      if (Date.now() - startTime > 50000) break; // max 50s
    }

    reader.releaseLock();

    expect(eventTypes.has("agent_start")).toBe(true);
    expect(textDeltaCount).toBeGreaterThan(0);

    // Cleanup
    await fetch(`${BASE}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }, 60000);

  it("POST /sessions/:id/chat SSE 工具调用流程", { timeout: 60000 }, async () => {
    const createRes = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json() as any;

    const chatRes = await fetch(`${BASE}/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ message: "Run this command: echo hello-world" }),
    });

    expect(chatRes.status).toBe(200);

    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const eventTypes = new Set<string>();
    let gotAgentEnd = false;

    const startTime = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          const event = line.slice(7);
          eventTypes.add(event);
          if (event === "agent_end") {
            gotAgentEnd = true;
            reader.cancel();
          }
        }
      }

      if (gotAgentEnd) break;
      if (Date.now() - startTime > 50000) break;
    }

    reader.releaseLock();

    // 应该收到 tool_execution 事件
    expect(eventTypes.has("tool_execution_start")).toBe(true);
    expect(eventTypes.has("tool_execution_end")).toBe(true);
    expect(eventTypes.has("agent_start")).toBe(true);

    await fetch(`${BASE}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }, 60000);
});
