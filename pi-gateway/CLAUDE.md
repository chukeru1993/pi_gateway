# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

pi HTTP Gateway — 基于 Fastify 的 HTTP 网关，将 pi CLI 的 RPC 模式（JSONL stdin/stdout）封装为 RESTful API + SSE 流。核心设计原则：**零侵入 pi 源码**，通过子进程管理实现协议桥接。

## 常用命令

```bash
# 安装依赖
npm install --ignore-scripts

# 开发（热重载）
npm run dev                  # tsx watch src/index.ts

# 编译
npm run build                # tsc → dist/

# 生产启动
JWT_SECRET=xxx node dist/index.js

# 运行单个测试文件
npx vitest run test/auth.test.ts

# 运行所有测试
npx vitest run
```

**注意：** 测试中 `pi-process.test.ts` 和 `routes/e2e-sse.test.ts` 需要 `pi` CLI 全局可用且配置了 API key，属于集成测试。

## 架构

### 核心数据流

```
HTTP Client → Fastify Routes → PiProcessPool → PiProcess (spawn "pi --mode rpc")
                                                  ↕ JSONL stdin/stdout
SSE Client  ← SSEWriter ← PiProcess.onEvent()
```

### 关键模块

- **`src/index.ts`** — 入口。Fastify 应用初始化、CORS、rate-limit、auth hook 注册、路由挂载、SSE 心跳、优雅关闭
- **`src/pi-process.ts`** — `PiProcess` 类。封装单个 pi 子进程的生命周期：JSONL 读写、命令发送（带超时的 Promise）、事件广播、空闲计时、内存监控、hang 检测（5 分钟无输出则 SIGKILL）
- **`src/pi-process-pool.ts`** — `PiProcessPool` 类。管理所有 `PiProcess` 实例的 Map，负责创建/销毁、系统内存压力驱逐（每 30 秒检查）、并发数限制
- **`src/sse-writer.ts`** — `SSEWriter` 接口，将事件写为标准 SSE 帧（`event: xxx\ndata: json\n\n`）
- **`src/auth.ts`** — HS256 JWT 验证（无第三方库），`authHook` 作为 Fastify preHandler
- **`src/security.ts`** — CWD 路径白名单校验 + bash 危险命令正则过滤
- **`src/metrics.ts`** — `SessionSnapshot` / `GatewayMetrics` / `RecentEvent` 类型定义 + 事件收集（保留最近 50 条）
- **`src/dashboard-html.ts`** — 内嵌 Admin Dashboard HTML（单文件 SPA，无构建步骤）

### 路由模块（`src/routes/`）

每个文件导出 `registerXxxRoutes(app, pool)` 函数，在 `index.ts` 中统一注册：

| 文件 | 职责 |
|------|------|
| `sessions.ts` | POST/DELETE /sessions，会话 CRUD |
| `state.ts` | GET /sessions/:id/state, /stats |
| `chat.ts` | POST /chat（SSE 流）、/steer、/follow-up、/abort |
| `ui-response.ts` | POST /ui-response、GET /pending-ui-requests |
| `model-config.ts` | 模型切换、思考级别、批量配置 |
| `session-ops.ts` | 消息列表、压缩、bash 执行、导出 |
| `lifecycle.ts` | new-session、switch、fork、clone |
| `admin.ts` | /admin 页面 + /admin/api/* 管理接口 |

### PiProcess ↔ pi RPC 协议

- 发送命令：`pi.sendCommand({ type: "prompt", message })` → 写入 stdin JSONL → 等待 stdout 带匹配 `id` 的 response
- 事件监听：`pi.onEvent(callback)` 订阅 stdout 所有非 response 类型的消息
- UI 交互：pi 发送 `extension_ui_request` → 网关转发为 SSE `user_question` → 前端 POST `/ui-response` → 网关回写 `extension_ui_response`

## 环境变量

- `JWT_SECRET`（必需）— JWT 签名密钥
- `GATEWAY_PORT` / `PORT` — 监听端口，默认 3000
- `MAX_SESSIONS` — 最大并发会话数，默认 50
- `IDLE_TIMEOUT_MINUTES` — 空闲回收，默认 30 分钟
- `PI_CWD_ROOT` — CWD 白名单前缀，逗号分隔，默认 `/workspace`
- `CORS_ORIGIN` — 允许来源，逗号分隔
- `HANG_TIMEOUT_MINUTES` — hang 检测超时，默认 5 分钟
- `DISABLE_SYSTEM_MEMORY_EVICTION` — 设为 `true` 禁用系统内存驱逐
- `SYSTEM_MEMORY_EVICTION_THRESHOLD` — 内存驱逐阈值（macOS 默认 0.99，Linux 默认 0.95）

## 开发注意事项

- ESM 项目（`"type": "module"`），所有导入需带 `.js` 后缀
- TypeScript target ES2022，module Node16
- 无第三方 JWT 库，`auth.ts` 使用 `node:crypto` 手动实现
- `PiProcess` 的 `updateMemoryUsage()` 仅在 Linux 上通过 `/proc/[pid]/statm` 读取，macOS 返回 0
- SSE 连接同一会话同时只允许一个活跃，新连接会断开旧连接
- `/health` 和 `/admin` 路径不走 JWT 认证
