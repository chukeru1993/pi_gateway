import type { FastifyInstance } from "fastify";
import * as os from "node:os";
import type { PiProcessPool } from "../pi-process-pool.js";
import type { GatewayMetrics, SessionSnapshot } from "../metrics.js";
import { getDashboardHTML } from "../dashboard-html.js";

export function registerAdminRoutes(app: FastifyInstance, pool: PiProcessPool, maxSessions: number) {
  app.register(async (scope) => {
    scope.get("/", async (_req, reply) => {
      reply.type("text/html").send(getDashboardHTML());
    });

    scope.get("/api/metrics", async (): Promise<GatewayMetrics> => {
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      return {
        uptime: process.uptime(),
        totalSessionsCreated: pool.sessionsCreated,
        totalSessionsDestroyed: pool.sessionsDestroyed,
        activeSessions: pool.size,
        maxSessions,
        totalPrompts: pool.promptsSent,
        totalErrors: pool.errorsCount,
        gatewayMemoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        systemMemoryPercent: Math.round((usedMem / totalMem) * 100),
        events: pool.recentEvents.slice(-50),
      };
    });

    scope.get("/api/sessions", async (): Promise<{ sessions: SessionSnapshot[] }> => {
      await pool.refreshAllMemory();
      const sessions: SessionSnapshot[] = [];
      for (const [id, pi] of pool.all()) {
        sessions.push({
          sessionId: id,
          status: pi.isStreaming ? "streaming" : pi.isCompacting ? "compacting" : "idle",
          model: pi.currentModel ?? "-",
          provider: pi.currentProvider ?? "-",
          cwd: pi.cwd ?? "-",
          messageCount: pi.messageCount ?? 0,
          pendingMessageCount: pi.pendingMessageCount ?? 0,
          steeringQueue: pi.steeringQueue ?? [],
          followUpQueue: pi.followUpQueue ?? [],
          thinkingLevel: pi.thinkingLevel ?? "-",
          autoCompactionEnabled: pi.autoCompactionEnabled,
          autoRetryEnabled: pi.autoRetryEnabled,
          createdAt: pi.createdAt,
          lastActivityAt: pi.lastActivityAt,
          memoryMB: Math.round(pi.getChildProcessMemory() / 1024 / 1024),
          pendingUiQuestions: pi.getPendingUiRequests().length,
        });
      }
      return { sessions };
    });

    scope.get("/api/sessions/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const pi = pool.get(id);
      if (!pi) return reply.code(404).send({ error: "Session not found" });
      await pi.updateMemoryUsage();
      const snapshot: SessionSnapshot = {
        sessionId: id,
        status: pi.isStreaming ? "streaming" : pi.isCompacting ? "compacting" : "idle",
        model: pi.currentModel ?? "-",
        provider: pi.currentProvider ?? "-",
        cwd: pi.cwd ?? "-",
        messageCount: pi.messageCount ?? 0,
        pendingMessageCount: pi.pendingMessageCount ?? 0,
        steeringQueue: pi.steeringQueue ?? [],
        followUpQueue: pi.followUpQueue ?? [],
        thinkingLevel: pi.thinkingLevel ?? "-",
        autoCompactionEnabled: pi.autoCompactionEnabled,
        autoRetryEnabled: pi.autoRetryEnabled,
        createdAt: pi.createdAt,
        lastActivityAt: pi.lastActivityAt,
        memoryMB: Math.round(pi.getChildProcessMemory() / 1024 / 1024),
        pendingUiQuestions: pi.getPendingUiRequests().length,
      };
      return snapshot;
    });
  }, { prefix: "/admin" });
}
