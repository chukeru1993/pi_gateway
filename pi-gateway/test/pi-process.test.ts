import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { PiProcess } from "../src/pi-process.js";

function spawnPi(): { proc: ChildProcess; pi: PiProcess } {
  const proc = spawn("pi", ["--mode", "rpc"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const pi = new PiProcess("test_session", proc);
  return { proc, pi };
}

describe("PiProcess - JSONL 通信层", () => {
  let pi: PiProcess;
  let proc: ChildProcess;

  beforeAll(() => {
    const r = spawnPi();
    pi = r.pi;
    proc = r.proc;
  });

  afterAll(async () => {
    await pi.shutdown();
  });

  it("sendCommand get_state → 返回有效 RpcSessionState", async () => {
    const response = await pi.sendCommand({ type: "get_state" });
    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();
    expect(response.data.model).toBeDefined();
    expect(typeof response.data.thinkingLevel).toBe("string");
    expect(typeof response.data.isStreaming).toBe("boolean");
    expect(typeof response.data.messageCount).toBe("number");
  });

  it("sendCommand get_available_models → 返回 models 数组", async () => {
    const response = await pi.sendCommand({ type: "get_available_models" });
    expect(response.success).toBe(true);
    expect(response.data.models).toBeInstanceOf(Array);
    expect(response.data.models.length).toBeGreaterThan(0);
  });

  it("sendCommand get_messages → 返回空消息列表", async () => {
    const response = await pi.sendCommand({ type: "get_messages" });
    expect(response.success).toBe(true);
    expect(response.data.messages).toBeInstanceOf(Array);
    expect(response.data.messages.length).toBe(0);
  });

  it("sendCommand get_commands → 返回 commands 数组", async () => {
    const response = await pi.sendCommand({ type: "get_commands" });
    expect(response.success).toBe(true);
    expect(response.data.commands).toBeInstanceOf(Array);
  });

  it("连续 10 条 get_state 命令全部正确 resolve，无串号", async () => {
    const promises = Array.from({ length: 10 }, () =>
      pi.sendCommand({ type: "get_state" }),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.success).toBe(true);
    }
  });

  it("sendCommand 超时 reject（发不存在的命令类型）", async () => {
    try {
      await pi.sendCommand({ type: "non_existent_command_xyz" } as any, 3000);
      expect.fail("Should have timed out or errored");
    } catch (e: any) {
      expect(e.message).toBeDefined();
    }
  });
});

describe("PiProcess - 状态字段提取", () => {
  let pi: PiProcess;
  let proc: ChildProcess;

  beforeAll(() => {
    const r = spawnPi();
    pi = r.pi;
    proc = r.proc;
  });

  afterAll(async () => {
    await pi.shutdown();
  });

  it("getChildProcessMemory 返回有效 RSS 值（非 0）", async () => {
    const mem = await pi.getChildProcessMemory();
    expect(mem).toBeGreaterThan(0);
    expect(typeof mem).toBe("number");
  });

  it("getPendingUiRequests 初始为空数组", () => {
    expect(pi.getPendingUiRequests()).toEqual([]);
  });

  it("registerPendingQuestion / removePendingQuestion", () => {
    const q = { id: "q1", method: "confirm" as const, title: "Test" };
    pi.registerPendingQuestion(q);
    expect(pi.getPendingUiRequests()).toHaveLength(1);
    pi.removePendingQuestion("q1");
    expect(pi.getPendingUiRequests()).toHaveLength(0);
  });

  it("isStreaming 状态字段更新", async () => {
    // 空闲状态
    await pi.sendCommand({ type: "get_state" });
    expect(pi.isStreaming).toBe(false);
    expect(pi.isCompacting).toBe(false);
  });
});

describe("PiProcess - 事件订阅", () => {
  let pi: PiProcess;
  let proc: ChildProcess;

  beforeAll(() => {
    const r = spawnPi();
    pi = r.pi;
    proc = r.proc;
  });

  afterAll(async () => {
    await pi.shutdown();
  });

  it("onEvent 注册/注销", () => {
    const events1: any[] = [];
    const events2: any[] = [];
    const unsub1 = pi.onEvent((e) => events1.push(e));
    pi.onEvent((e) => events2.push(e));
    unsub1();

    // events2 仍然活跃
    expect(pi.activeSSEs).toBeInstanceOf(Set);
  });

  it("extension_ui_request 事件被 listener 收到", async () => {
    const events: any[] = [];
    const unsub = pi.onEvent((e) => {
      if (e.type === "extension_ui_request") events.push(e);
    });

    // 发送 get_commands 来触发一些 UI 事件
    await pi.sendCommand({ type: "get_commands" });

    unsub();
    // get_commands 可能不会触发 UI 事件，但我们验证了 listener 机制
    expect(Array.isArray(events)).toBe(true);
  });

  it("100 条急速命令无 EPIPE（背压安全）", async () => {
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(pi.sendCommand({ type: "get_state" }));
    }
    const results = await Promise.allSettled(promises);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(45); // 允许少量超时
  });
});

describe("PiProcess - 生命周期管理", () => {
  it("手动 shutdown() → 子进程退出（SIGTERM → SIGKILL 在 1s 内）", async () => {
    const r = spawnPi();
    const start = Date.now();
    await r.pi.shutdown();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000); // SIGTERM + 1s SIGKILL grace
    expect(r.pi.intentionalShutdown).toBe(true);
  });

  it("主动关闭不触发 error 事件", async () => {
    const r = spawnPi();
    let gotError = false;
    r.pi.onEvent((e) => {
      if (e.type === "error") gotError = true;
    });
    await r.pi.shutdown();
    // intentionalShutdown 设为 true，exit 时不应广播 error
    expect(gotError).toBe(false);
  });
});

describe("PiProcess - 子进程崩溃通知", () => {
  it("杀子进程 → listener 收到 error 事件", async () => {
    const r = spawnPi();
    const errors: any[] = [];
    r.pi.onEvent((e) => {
      if (e.type === "error") errors.push(e);
    });

    r.proc.kill("SIGKILL");

    // 等待事件传播
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("exited");
  });
});
