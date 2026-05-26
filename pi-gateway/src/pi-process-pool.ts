import { spawn } from "node:child_process";
import * as os from "node:os";
import { PiProcess } from "./pi-process.js";
import { collectEvent, type RecentEvent } from "./metrics.js";

const MAX_TOTAL_PROCESSES = parseInt(process.env.MAX_SESSIONS || "50", 10);
const MAX_MEMORY_PER_PROCESS = 2 * 1024 * 1024 * 1024; // 2GB
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MINUTES || "30", 10) * 60_000;
const SYSTEM_MEMORY_RATIO = 0.8;

export interface CreateOptions {
  provider?: string;
  model?: string;
  cwd?: string;
  noSession?: boolean;
  sessionDir?: string;
  thinkingLevel?: string;
}

export class PiProcessPool {
  private processes = new Map<string, PiProcess>();
  sessionsCreated = 0;
  sessionsDestroyed = 0;
  promptsSent = 0;
  errorsCount = 0;
  recentEvents: RecentEvent[] = [];

  async create(sessionId: string, options: CreateOptions = {}): Promise<PiProcess> {
    if (this.processes.size >= MAX_TOTAL_PROCESSES) {
      throw new Error("Maximum concurrent sessions reached");
    }

    const args = ["--mode", "rpc"];
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    if (options.noSession) args.push("--no-session");
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.cwd) args.push("--cwd", options.cwd);

    const proc = spawn("pi", args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const pi = new PiProcess(sessionId, proc, {
      cwd: options.cwd,
      onIdleTimeout: () => this.destroy(sessionId),
      onMemoryEvict: () => this.destroy(sessionId, "memory", "ejected"),
      onCrash: (reason) => {
        this.processes.delete(sessionId);
        this.sessionsDestroyed++;
        this.errorsCount++;
        collectEvent(this.recentEvents, "crashed", sessionId, reason);
      },
    });

    this.processes.set(sessionId, pi);
    this.sessionsCreated++;

    pi.startIdleTimer(IDLE_TIMEOUT_MS);
    pi.startMemoryMonitor(MAX_MEMORY_PER_PROCESS);

    return pi;
  }

  get(sessionId: string): PiProcess | undefined {
    return this.processes.get(sessionId);
  }

  async destroy(sessionId: string, detail = "timeout", eventType: RecentEvent["type"] = "destroyed"): Promise<void> {
    const pi = this.processes.get(sessionId);
    if (pi) {
      await pi.shutdown();
      this.processes.delete(sessionId);
      this.sessionsDestroyed++;
      collectEvent(this.recentEvents, eventType, sessionId, detail);
    }
  }

  startSystemMemoryMonitor() {
    setInterval(() => {
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      if (usedMem / totalMem <= SYSTEM_MEMORY_RATIO) return;

      let oldest: PiProcess | null = null;
      let oldestId: string | null = null;
      for (const [id, pi] of this.processes) {
        if (pi.isStreaming || pi.isCompacting) continue;
        if (!oldest || pi.lastActivityAt < oldest.lastActivityAt) {
          oldest = pi;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.destroy(oldestId, "system memory > 80%", "ejected");
      }
    }, 30_000);
  }

  all(): Iterable<[string, PiProcess]> {
    return this.processes.entries();
  }

  get size(): number {
    return this.processes.size;
  }
}
