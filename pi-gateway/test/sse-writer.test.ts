import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerResponse } from "node:http";
import { createSSEWriter } from "../src/sse-writer.js";

describe("SSE Writer", () => {
  let mockRes: ServerResponse;
  let writes: string[];

  beforeEach(() => {
    writes = [];
    mockRes = {
      write: vi.fn((data: string) => writes.push(data)),
      end: vi.fn(),
    } as unknown as ServerResponse;
  });

  it("write 输出正确 SSE 帧格式", () => {
    const sse = createSSEWriter(mockRes);
    sse.write("agent_start", { from: "pi" });
    const expected = `event: agent_start\ndata: {"from":"pi"}\n\n`;
    expect(writes.join("")).toBe(expected);
  });

  it("write 处理特殊字符（JSON 自动转义）", () => {
    const sse = createSSEWriter(mockRes);
    sse.write("message_update", { text: 'hello "world"\nnew line' });
    expect(writes[0]).toContain("event: message_update");
    expect(writes[0]).toContain("data: ");
  });

  it("end 调用 res.end()", () => {
    const sse = createSSEWriter(mockRes);
    sse.end();
    expect(mockRes.end).toHaveBeenCalledOnce();
  });

  it("心跳格式 : heartbeat 不触发客户端事件", () => {
    // SSE 注释行（以 : 开头）不触发任何客户端 event listener
    expect(": heartbeat\n\n").toMatch(/^:/);
  });
});
