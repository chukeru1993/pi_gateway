import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { PiProcess } from "./pi-process.js";
import { collectEvent, type RecentEvent } from "./metrics.js";

const MAX_TOTAL_PROCESSES = parseInt(process.env.MAX_SESSIONS || "50", 10);
const MAX_MEMORY_PER_PROCESS = 2 * 1024 * 1024 * 1024; // 2GB
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MINUTES || "30", 10) * 60_000;
const SYSTEM_MEMORY_RATIO = parseFloat(process.env.SYSTEM_MEMORY_EVICTION_THRESHOLD || "0.95");
const SYSTEM_MEMORY_EVICTION_DISABLED = process.env.DISABLE_SYSTEM_MEMORY_EVICTION === "true";

function isMemoryPressured(): boolean {
  if (os.platform() === "darwin") {
    try {
      const out = execSync("memory_pressure", { encoding: "utf8", timeout: 5000 });
      const match = out.match(/System-wide memory free percentage:\s*(\d+)/);
      if (match) {
        const freePct = parseInt(match[1]);
        // macOS shows available (free + cache) percentage; evict when truly low
        return freePct < 10;
      }
      return false;
    } catch {
      return false;
    }
  }
  const used = os.totalmem() - os.freemem();
  return used / os.totalmem() > SYSTEM_MEMORY_RATIO;
}

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
    if (SYSTEM_MEMORY_EVICTION_DISABLED) return;
    setInterval(() => {
      if (!isMemoryPressured()) return;

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
        let freePct = Math.round((os.freemem() / os.totalmem()) * 100);
        if (os.platform() === "darwin") {
          try {
            const out = execSync("memory_pressure", { encoding: "utf8", timeout: 5000 });
            const m = out.match(/System-wide memory free percentage:\s*(\d+)/);
            if (m) freePct = parseInt(m[1]);
          } catch {}
        }
        this.destroy(oldestId, `system memory pressure (${freePct}% free)`, "ejected");
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
