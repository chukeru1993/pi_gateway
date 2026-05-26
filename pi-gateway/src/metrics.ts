export interface SessionSnapshot {
  sessionId: string;
  status: "idle" | "streaming" | "compacting";
  model: string;
  provider: string;
  cwd: string;
  messageCount: number;
  pendingMessageCount: number;
  steeringQueue: string[];
  followUpQueue: string[];
  thinkingLevel: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  createdAt: number;
  lastActivityAt: number;
  memoryMB: number;
  pendingUiQuestions: number;
}

export interface GatewayMetrics {
  uptime: number;
  totalSessionsCreated: number;
  totalSessionsDestroyed: number;
  activeSessions: number;
  maxSessions: number;
  totalPrompts: number;
  totalErrors: number;
  gatewayMemoryMB: number;
  systemMemoryPercent: number;
  events: RecentEvent[];
}

export interface RecentEvent {
  timestamp: number;
  sessionId: string;
  type: "created" | "destroyed" | "prompt" | "error" | "crashed" | "compaction" | "ejected";
  detail: string;
}

export function collectEvent(
  events: RecentEvent[],
  type: RecentEvent["type"],
  sessionId: string,
  detail: string,
): void {
  events.push({ timestamp: Date.now(), sessionId, type, detail });
  if (events.length > 50) {
    events.shift();
  }
}
