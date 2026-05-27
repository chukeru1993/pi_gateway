import { type ChildProcess, spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";

export interface PendingUIQuestion {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

const execAsync = promisify(exec);

export class PiProcess {
  private proc: ChildProcess;
  private requestId = 0;
  private pendingResponses = new Map<string, {
    resolve: (msg: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private eventListeners = new Set<(event: any) => void>();
  private writeQueue: string[] = [];
  private draining = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private memoryTimer?: ReturnType<typeof setInterval>;
  private hangTimer?: ReturnType<typeof setTimeout>;
  private readonly HANG_TIMEOUT = parseInt(process.env.HANG_TIMEOUT_MINUTES || "5", 10) * 60_000;
  public intentionalShutdown = false;
  private onIdleTimeout: (() => void) | undefined;
  private onMemoryEvict: (() => void) | undefined;
  private onCrash: ((reason: string) => void) | undefined;

  public cwd?: string;
  public currentModel?: string;
  public currentProvider?: string;
  public thinkingLevel?: string;
  public isStreaming = false;
  public isCompacting = false;
  public messageCount = 0;
  public pendingMessageCount = 0;
  public steeringQueue: string[] = [];
  public followUpQueue: string[] = [];
  public autoCompactionEnabled = true;
  public autoRetryEnabled = true;
  public createdAt = Date.now();
  public lastActivityAt = Date.now();
  public activeSSEs: Set<object> = new Set();
  public pendingUiRequests = new Map<string, PendingUIQuestion>();

  constructor(
    public sessionId: string,
    proc: ChildProcess,
    options: { cwd?: string; onIdleTimeout?: () => void; onMemoryEvict?: () => void; onCrash?: (reason: string) => void } = {},
  ) {
    this.proc = proc;
    this.cwd = options.cwd;
    this.onIdleTimeout = options.onIdleTimeout;
    this.onMemoryEvict = options.onMemoryEvict;
    this.onCrash = options.onCrash;
    this.attachReader();

    this.proc.stderr?.on("data", (_chunk) => {});

    this.proc.on("exit", (code, signal) => {
      if (!this.intentionalShutdown) {
        for (const listener of this.eventListeners) {
          listener({
            type: "error",
            message: `Agent process exited (code=${code}, signal=${signal})`,
            code,
            signal,
          });
        }
        for (const sse of this.activeSSEs) {
          (sse as any).end();
        }
        this.onCrash?.(`exited code=${code} signal=${signal}`);
      }
    });
  }

  private attachReader() {
    let buffer = "";
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            this.handleLine(JSON.parse(line));
          } catch {}
        }
      }
    });
  }

  private resetHangTimer() {
    if (this.hangTimer) clearTimeout(this.hangTimer);
    this.hangTimer = setTimeout(() => {
      for (const listener of this.eventListeners) {
        listener({
          type: "error",
          message: "Agent process appears hung (no output for 5 minutes)",
        });
      }
      this.proc.kill("SIGKILL");
    }, this.HANG_TIMEOUT);
  }

  private handleLine(msg: any) {
    this.lastActivityAt = Date.now();
    this.resetHangTimer();

    if (msg.type === "response" && msg.id) {
      const pending = this.pendingResponses.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingResponses.delete(msg.id);
        if (msg.success) {
          if (msg.command === "get_state") {
            const s = msg.data;
            if (s.model) {
              this.currentModel = s.model.id;
              this.currentProvider = s.model.provider;
            }
            if (s.thinkingLevel !== undefined) this.thinkingLevel = s.thinkingLevel;
            if (s.messageCount !== undefined) this.messageCount = s.messageCount;
            if (s.pendingMessageCount !== undefined) this.pendingMessageCount = s.pendingMessageCount;
          }
          if (msg.command === "set_model") {
            if (msg.data?.id) this.currentModel = msg.data.id;
          }
          pending.resolve(msg);
        } else {
          pending.reject(new Error(msg.error));
        }
      }
      return;
    }

    switch (msg.type) {
      case "agent_start":
        this.isStreaming = true;
        break;
      case "agent_end":
        this.isStreaming = false;
        break;
      case "compaction_start":
        this.isCompacting = true;
        break;
      case "compaction_end":
        this.isCompacting = false;
        break;
      case "queue_update":
        if (msg.steering) this.steeringQueue = msg.steering;
        if (msg.followUp) this.followUpQueue = msg.followUp;
        break;
    }

    for (const listener of this.eventListeners) {
      listener(msg);
    }
  }

  async sendCommand(cmd: any, timeout = 30_000): Promise<any> {
    this.resetHangTimer();
    const id = `req_${++this.requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`Command timeout: ${cmd.type}`));
      }, timeout);
      this.pendingResponses.set(id, { resolve, reject, timer });
      this.write({ ...cmd, id });
    });
  }

  sendUiResponse(id: string, response: any) {
    this.write({ type: "extension_ui_response", id, ...response });
  }

  private write(obj: unknown) {
    const line = JSON.stringify(obj) + "\n";
    if (this.draining) {
      this.writeQueue.push(line);
    } else {
      const ok = this.proc.stdin!.write(line);
      if (!ok) {
        this.draining = true;
        const drainHandler = () => {
          this.proc.stdin!.removeListener("drain", drainHandler);
          this.draining = false;
          for (const queued of this.writeQueue) {
            this.proc.stdin!.write(queued);
          }
          this.writeQueue = [];
        };
        this.proc.stdin!.on("drain", drainHandler);
      }
    }
  }

  onEvent(listener: (event: any) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  startIdleTimer(timeoutMs: number) {
    this.idleTimer = setTimeout(() => {
      this.onIdleTimeout?.();
    }, timeoutMs);
  }

  resetIdleTimer() {
    if (!this.idleTimer) return;
    this.idleTimer.refresh();
    this.resetHangTimer();
  }

  startMemoryMonitor(maxBytes: number) {
    this.memoryTimer = setInterval(async () => {
      try {
        const mem = await this.getChildProcessMemory();
        if (mem > maxBytes) {
          for (const listener of this.eventListeners) {
            listener({
              type: "error",
              message: `Session memory limit exceeded (${Math.round(mem / 1024 / 1024)}MB), shutting down`,
            });
          }
          this.onMemoryEvict?.();
        }
      } catch {}
    }, 10_000);
  }

  async getChildProcessMemory(): Promise<number> {
    if (!this.proc.pid) return 0;
    try {
      const statm = await fs.readFile(`/proc/${this.proc.pid}/statm`, "utf8");
      const pages = parseInt(statm.split(" ")[1], 10);
      if (!isNaN(pages)) return pages * 4096;
    } catch {}
    try {
      const { stdout } = await execAsync(`ps -o rss= -p ${this.proc.pid}`, { encoding: "utf8" });
      const kb = parseInt(stdout.trim(), 10);
      if (!isNaN(kb)) return kb * 1024;
    } catch {}
    return 0;
  }

  getPendingUiRequests(): PendingUIQuestion[] {
    return Array.from(this.pendingUiRequests.values());
  }

  registerPendingQuestion(q: PendingUIQuestion) {
    this.pendingUiRequests.set(q.id, q);
  }

  removePendingQuestion(id: string) {
    this.pendingUiRequests.delete(id);
  }

  setIntentionalShutdown() {
    this.intentionalShutdown = true;
  }

  async shutdown() {
    this.intentionalShutdown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.hangTimer) clearTimeout(this.hangTimer);
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!this.proc.killed) this.proc.kill("SIGKILL");
    }, 1000);
  }
}
