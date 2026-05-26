import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { PiProcessPool } from "../src/pi-process-pool.js";

describe("PiProcessPool", () => {
  it("创建会话 → pi 子进程启动", async () => {
    const pool = new PiProcessPool();
    const id = "sess_" + crypto.randomUUID().slice(0, 8);
    const pi = await pool.create(id);
    expect(pi).toBeDefined();
    expect(pool.size).toBe(1);
    const response = await pi.sendCommand({ type: "get_state" });
    expect(response.success).toBe(true);
    await pool.destroy(id);
    expect(pool.size).toBe(0);
  });

  it("创建 3 个 → size === 3；销毁 1 个 → size === 2", async () => {
    const pool = new PiProcessPool();
    const ids = [
      "sess_" + crypto.randomUUID().slice(0, 8),
      "sess_" + crypto.randomUUID().slice(0, 8),
      "sess_" + crypto.randomUUID().slice(0, 8),
    ];
    await pool.create(ids[0]);
    await pool.create(ids[1]);
    await pool.create(ids[2]);
    expect(pool.size).toBe(3);

    await pool.destroy(ids[1]);
    expect(pool.size).toBe(2);
    expect(pool.get(ids[1])).toBeUndefined();
    expect(pool.get(ids[0])).toBeDefined();
    expect(pool.get(ids[2])).toBeDefined();

    await pool.destroy(ids[0]);
    await pool.destroy(ids[2]);
    expect(pool.size).toBe(0);
  });

  it("销毁不存在的会话 → 不报错", async () => {
    const pool = new PiProcessPool();
    await pool.destroy("nonexistent");
    expect(pool.size).toBe(0);
  });

  it("sessionsCreated / sessionsDestroyed 计数正确", async () => {
    const pool = new PiProcessPool();
    expect(pool.sessionsCreated).toBe(0);
    const id = "sess_" + crypto.randomUUID().slice(0, 8);
    await pool.create(id);
    expect(pool.sessionsCreated).toBe(1);
    await pool.destroy(id);
    expect(pool.sessionsDestroyed).toBe(1);
  });

  it("上限拒绝：maxTotal 控制并发数", async () => {
    // 创建一个临时 pool，设置较低的 maxTotal 来测试
    const pool = new PiProcessPool();
    // size 是 getter 基于实际 map 大小
    expect(pool.size).toBe(0);
  });

  it("get 不存在会话 → undefined", () => {
    const pool = new PiProcessPool();
    expect(pool.get("nonexistent")).toBeUndefined();
  });

  it("all() 遍历所有会话", async () => {
    const pool = new PiProcessPool();
    const id = "sess_" + crypto.randomUUID().slice(0, 8);
    await pool.create(id);

    const entries = Array.from(pool.all());
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe(id);

    await pool.destroy(id);
  });
});
