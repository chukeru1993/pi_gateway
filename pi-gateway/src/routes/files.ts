import type { FastifyInstance } from "fastify";
import type { PiProcessPool } from "../pi-process-pool.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ALLOWED_CWD_PREFIXES = (process.env.PI_CWD_ROOT || "/workspace").split(",");
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

function isPathAllowed(filePath: string): boolean {
  const abs = path.resolve(filePath);
  // 允许 CWD 白名单路径
  const inCwd = ALLOWED_CWD_PREFIXES.some((p) => {
    const resolved = path.resolve(p);
    return abs === resolved || abs.startsWith(resolved + "/");
  });
  if (inCwd) return true;
  // 允许 gateway 工作目录下的 out/ 目录（Agent 生成文件的默认位置）
  const gatewayOut = path.resolve(process.cwd(), "out");
  return abs.startsWith(gatewayOut + "/");
}

export function registerFileRoutes(app: FastifyInstance, _pool: PiProcessPool) {
  app.get<{ Params: { id: string; "*": string } }>("/sessions/:id/files/*", async (req, reply) => {
    const sessionId = req.params.id;
    const filePath = req.params["*"];

    if (!filePath) {
      return reply.code(400).send({ error: "Missing file path" });
    }

    // 解析绝对路径
    let absPath = path.resolve("/", filePath);

    // 如果路径不在白名单内，尝试在 gateway out/ 目录查找
    if (!isPathAllowed(absPath)) {
      const gatewayOutPath = path.resolve(process.cwd(), "out", path.basename(filePath));
      if (isPathAllowed(gatewayOutPath)) {
        absPath = gatewayOutPath;
      }
    }

    req.log.info({ sessionId, filePath, absPath }, "File download request");

    if (!isPathAllowed(absPath)) {
      req.log.warn({ absPath }, "File path not allowed");
      return reply.code(403).send({ error: "Path not allowed" });
    }

    try {
      const stat = await fs.stat(absPath);

      if (!stat.isFile()) {
        return reply.code(404).send({ error: "Not a file" });
      }

      if (stat.size > MAX_FILE_SIZE) {
        return reply.code(413).send({ error: "File too large (max 50MB)" });
      }

      const ext = path.extname(absPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const fileName = path.basename(absPath);

      req.log.info({ absPath, size: stat.size, ext, contentType }, "Serving file");

      const content = await fs.readFile(absPath);

      reply
        .header("Content-Type", contentType)
        .header("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`)
        .header("Content-Length", content.length);

      return reply.send(content);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        return reply.code(404).send({ error: "File not found" });
      }
      req.log.error({ err: e }, "Failed to read file");
      return reply.code(500).send({ error: "Failed to read file" });
    }
  });
}
