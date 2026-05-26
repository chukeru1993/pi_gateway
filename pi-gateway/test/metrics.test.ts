import { describe, it, expect } from "vitest";
import { collectEvent, type RecentEvent } from "../src/metrics.js";

describe("Metrics", () => {
  it("collectEvent 追加事件到数组", () => {
    const events: RecentEvent[] = [];
    collectEvent(events, "created", "sess_1", "test session");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "created",
      sessionId: "sess_1",
      detail: "test session",
    });
    expect(events[0].timestamp).toBeGreaterThan(0);
  });

  it("超过 50 条事件时环形缓冲区正确覆盖", () => {
    const events: RecentEvent[] = [];
    for (let i = 0; i < 60; i++) {
      collectEvent(events, "prompt", `sess_${i}`, `test ${i}`);
    }
    expect(events).toHaveLength(50);
    expect(events[0].sessionId).toBe("sess_10");
    expect(events[49].sessionId).toBe("sess_59");
  });
});
