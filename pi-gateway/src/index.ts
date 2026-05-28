import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { PiProcessPool } from "./pi-process-pool.js";
import { authHook } from "./auth.js";
import type { SSEWriter } from "./sse-writer.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerStateRoutes } from "./routes/state.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerUiResponseRoutes } from "./routes/ui-response.js";
import { registerModelConfigRoutes } from "./routes/model-config.js";
import { registerSessionOpsRoutes } from "./routes/session-ops.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerAdminRoutes } from "./routes/admin.js";

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || process.env.PORT || "3000", 10);
const CORS_ORIGINS = process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:5173", "null"];
const MAX_TOTAL_PROCESSES = parseInt(process.env.MAX_SESSIONS || "50", 10);

function validateEnv() {
  const required = ["JWT_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn("No AI provider API key configured — agent will fail on prompt");
  }
}

validateEnv();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    ...(process.env.NODE_ENV === "production" ? {} : {
      transport: { target: "pino-pretty" },
    }),
  },
  trustProxy: process.env.TRUST_PROXY !== "false",
});

const usesWildcard = CORS_ORIGINS.includes("*");
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  keyGenerator: (req) => req.headers.authorization || req.ip,
});

const pool = new PiProcessPool();
pool.startSystemMemoryMonitor();

// --- Health endpoint (no auth) ---
app.get("/health", async () => {
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  return {
    status: "ok",
    activeSessions: pool.size,
    maxSessions: MAX_TOTAL_PROCESSES,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    systemMemoryPercent: Math.round((usedMem / totalMem) * 100),
  };
});

// --- Auth hooks ---
app.addHook("preHandler", async (req, reply) => {
  if ((req.routeOptions.url || req.url) === "/health") return;
  if ((req.url || "").startsWith("/admin")) return;
  try {
    await authHook(req as any);
  } catch (e: any) {
    reply.code(e.statusCode || 401).send({ error: e.message });
  }
});

app.addHook("preHandler", async (req) => {
  (req as any).log = req.log.child({
    requestId: crypto.randomUUID().slice(0, 8),
    sessionId: (req.params as any)?.id ?? "-",
  });
});

// --- Register all routes ---
registerSessionRoutes(app, pool);
registerStateRoutes(app, pool);
registerChatRoutes(app, pool);
registerUiResponseRoutes(app, pool);
registerModelConfigRoutes(app, pool);
registerSessionOpsRoutes(app, pool);
registerLifecycleRoutes(app, pool);

// Admin routes (dev convenience: no auth required)
app.register(async (scope) => {
  registerAdminRoutes(scope, pool, MAX_TOTAL_PROCESSES);
});

// --- SSE heartbeat ---
const heartbeatInterval = setInterval(() => {
  for (const [, pi] of pool.all()) {
    for (const sse of pi.activeSSEs) {
      (sse as SSEWriter).heartbeat();
    }
  }
}, 15_000);

// --- Graceful shutdown ---
let shuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}, starting graceful shutdown...`);

  clearInterval(heartbeatInterval);

  for (const [, pi] of pool.all()) {
    pi.setIntentionalShutdown();
    for (const sse of pi.activeSSEs) {
      (sse as any).end();
    }
  }

  const shutdownTimeout = 10_000;
  const destroyPromises: Promise<void>[] = [];
  for (const [, pi] of pool.all()) {
    destroyPromises.push(pi.shutdown());
  }
  const result = await Promise.race([
    Promise.allSettled(destroyPromises),
    new Promise((r) => setTimeout(() => r("timeout"), shutdownTimeout)),
  ]);
  if (result === "timeout") {
    app.log.warn("Some child processes did not exit within timeout, force killing");
  }

  await app.close();
  process.exit(0);
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  app.log.error("Unhandled rejection: " + String(reason));
});

// --- Start ---
await app.listen({ port: GATEWAY_PORT, host: "0.0.0.0" });
app.log.info(`pi HTTP Gateway listening on port ${GATEWAY_PORT}`);
