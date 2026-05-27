# pi HTTP Gateway

基于 Fastify 的 HTTP 网关，将 pi CLI RPC 模式封装为 RESTful API + SSE 流，使前端/调用方可以通过 HTTP 协议与 pi 编码助手交互。

## 架构

```
  前端/调用方         HTTP/SSE         pi HTTP Gateway       JSONL/stdin/stdout        pi RPC 子进程
  ──────────  ←────────────────────→  ────────────────  ←────────────────────────→  ──────────────
                                        ├─ 会话池管理
                                        ├─ 请求路由
                                        ├─ SSE 事件转发
                                        ├─ UI 请求桥接
                                        └─ 内存/并发控制
```

核心设计：网关作为 pi RPC 子进程的 HTTP 代理，将 stdin/stdout JSONL 协议映射为 RESTful API + SSE 流，**零侵入 pi 源码**。

---

## 启动说明

### 前置条件

- Node.js >= 22
- `pi` CLI 已安装 (全局可用)
- AI 提供商的 API Key (如 `DEEPSEEK_API_KEY` 或 `ANTHROPIC_API_KEY`)

### 依赖安装

```bash
cd pi-gateway
npm install --ignore-scripts
```

### 编译

```bash
npm run build    # tsc 编译到 dist/
```

### 启动

**开发模式** (热重载):
```bash
JWT_SECRET=your-secret-key npx tsx src/index.ts
```

**生产模式**:
```bash
JWT_SECRET=your-secret-key node dist/index.js
```

**Docker**:
```bash
docker compose up -d
```

### 验证

```bash
curl http://localhost:3000/health
# → {"status":"ok","activeSessions":0,...}
```

---

## 环境变量

### 必需

| 变量 | 说明 |
|------|------|
| `JWT_SECRET` | JWT 签名密钥，用于签发和验证认证 token |

### 建议配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | - | DeepSeek API 密钥 |
| `ANTHROPIC_API_KEY` | - | Anthropic API 密钥 |
| `OPENAI_API_KEY` | - | OpenAI API 密钥 |

### 运行时配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GATEWAY_PORT` | `3000` | HTTP 监听端口（优先级高于 `PORT`） |
| `PORT` | `3000` | HTTP 监听端口（`GATEWAY_PORT` 未设置时生效） |
| `LOG_LEVEL` | `info` | 日志级别 (`debug` / `info` / `warn` / `error`) |
| `NODE_ENV` | - | 设为 `production` 时输出 JSON 日志 |
| `MAX_SESSIONS` | `50` | 最大并发会话数 |
| `IDLE_TIMEOUT_MINUTES` | `30` | 空闲会话自动回收时间（分钟） |
| `PI_CWD_ROOT` | `/workspace` | 允许的 cwd 路径前缀列表，逗号分隔 |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的跨域来源，逗号分隔 |
| `TRUST_PROXY` | `true` | 设为 `false` 禁用反向代理信任 |

---

## 认证

所有端点（除 `/health`）要求携带 JWT Bearer Token：

```
Authorization: Bearer <token>
```

### 生成 Token

使用 `src/auth.ts` 中的 `generateToken` 函数，或手动生成 HS256 JWT：

```javascript
const crypto = require("crypto");
const header = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  sub: "user-id",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 86400   // 24 小时
})).toString("base64url");
const sig = crypto.createHmac("sha256", Buffer.from(process.env.JWT_SECRET))
  .update(`${header}.${payload}`).digest("base64url");
const token = `${header}.${payload}.${sig}`;
```

---

## API 端点

### 基础

#### `GET /health`

健康检查，无需认证。

```json
{
  "status": "ok",
  "activeSessions": 3,
  "maxSessions": 50,
  "uptime": 3600.5,
  "memory": 120000000,
  "systemMemoryPercent": 65
}
```

---

### 会话管理

#### `POST /sessions`

创建新会话（启动 pi RPC 子进程）。

**Request Body**:

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `provider` | string | 否 | AI 提供商 |
| `model` | string | 否 | 模型 ID |
| `cwd` | string | 否 | 工作目录 (须在白名单内) |
| `noSession` | boolean | 否 | 不加载持久化会话 |
| `sessionDir` | string | 否 | 会话存储目录 |
| `thinkingLevel` | string | 否 | 思考级别: `"low"` / `"medium"` / `"high"` |

**Response** `201`:
```json
{
  "sessionId": "sess_abc123def",
  "status": "ready"
}
```

#### `DELETE /sessions/:id`

销毁会话并关闭 pi 子进程。

**Response** `200`:
```json
{ "ok": true }
```

#### `GET /sessions/:id/state`

获取会话状态（映射 `get_state` RPC 命令）。

```json
{
  "model": { "id": "claude-sonnet-4-5", "provider": "anthropic", ... },
  "thinkingLevel": "medium",
  "isStreaming": false,
  "isCompacting": false,
  "messageCount": 5,
  "pendingMessageCount": 0,
  "sessionFile": "/path/to/session.jsonl",
  "sessionId": "abc123",
  "sessionName": "my-feature"
}
```

#### `GET /sessions/:id/stats`

获取 Token/费用统计（映射 `get_session_stats` RPC 命令）。

---

### 对话 (核心)

#### `POST /sessions/:id/chat` — SSE 流

发送消息并接收 SSE 事件流。

> **注意**：此端点返回 `text/event-stream`。标准 `EventSource` API 不支持 POST，前端需使用 `fetch` + `ReadableStream` 手动解析 SSE 帧。

**Request Body**:

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 消息内容 |
| `images` | array | 否 | 图片数组 `[{type, data, mimeType}]` |
| `streamingBehavior` | string | 否 | `"steer"` 或 `"followUp"` |

**Response Headers**:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

##### SSE 事件类型

**消息生命周期**:
```
agent_start
  message_start
  message_update (thinking_start → thinking_delta × N → thinking_end)
  message_update (text_start → text_delta × N → text_end)
  message_update (toolcall_start → toolcall_delta → toolcall_end)
  message_update (done)
  message_end
  turn_end
agent_end
```

**工具执行**:
```
tool_execution_start → tool_execution_update → tool_execution_end
```

**队列状态**:
```
queue_update  → { "steering": [...], "followUp": [...] }
```

**压缩/重试**:
```
compaction_start / compaction_end
auto_retry_start / auto_retry_end
```

**UI 交互**:

| SSE event | 说明 | 数据格式 |
|-----------|------|---------|
| `user_question` | 需要前端应答的交互 | `{ id, method: "select"\|"confirm"\|"input"\|"editor", title, message?, options?, placeholder?, prefill?, timeout? }` |
| `notification` | 即发即弃的通知 | `{ id, message, notifyType }` |
| `status_update` | 状态栏更新 | `{ id, statusKey, statusText }` |
| `widget_update` | 部件更新 | `{ id, widgetKey, widgetLines, widgetPlacement }` |
| `title_update` | 标题更新 | `{ id, title }` |
| `editor_text_update` | 编辑器文本更新 | `{ id, text }` |

**错误**:
```
error  → { "message": "..." }
```

**心跳** (每 15 秒):
```
: heartbeat
```

#### `POST /sessions/:id/steer`

流式中途追加指令。

```json
{ "message": "Focus on error handling" }
```

#### `POST /sessions/:id/follow-up`

追加后续消息。

```json
{ "message": "Also check the logs" }
```

#### `POST /sessions/:id/abort`

中断当前执行。

---

### 用户交互

#### `POST /sessions/:id/ui-response`

应答 pi 发出的 `user_question` 事件。

```json
// confirm 应答
{ "id": "uuid-1", "confirmed": true }

// select 应答
{ "id": "uuid-2", "value": "Allow" }

// input/editor 应答
{ "id": "uuid-3", "value": "user input" }

// 取消
{ "id": "uuid-4", "cancelled": true }
```

**Response** `200`: `{ "ok": true }`

**校验约束**：`confirmed`、`value`、`cancelled` 三者必须精确提供一个。

#### `GET /sessions/:id/pending-ui-requests`

查询当前待处理的 UI 请求。当 SSE 连接断开后重连时，前端可通过此端点恢复 `user_question` 状态。

```json
{
  "questions": [
    { "id": "uuid-1", "method": "confirm", "title": "Allow command?", "message": "rm -rf /tmp", "timeout": 10000 }
  ]
}
```

---

### 模型与配置

#### `GET /sessions/:id/models`

获取可用模型列表。

#### `PUT /sessions/:id/model`

切换模型。

```json
{ "provider": "deepseek", "modelId": "deepseek-v4-pro" }
```

#### `PUT /sessions/:id/thinking-level`

设置思考级别。

```json
{ "level": "medium" }
```

#### `POST /sessions/:id/cycle-model`

循环切换模型。

#### `POST /sessions/:id/cycle-thinking-level`

循环切换思考级别。

#### `PUT /sessions/:id/config`

批量配置会话参数。

```json
{
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "autoCompactionEnabled": true,
  "autoRetryEnabled": true
}
```

---

### 会话操作

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sessions/:id/messages` | 获取所有消息 |
| POST | `/sessions/:id/compact` | 手动压缩上下文 `{ customInstructions? }` |
| POST | `/sessions/:id/bash` | 直接执行 bash 命令 `{ command }` |
| POST | `/sessions/:id/abort-bash` | 中断正在执行的 bash |
| GET | `/sessions/:id/commands` | 获取可用斜杠命令 |
| PUT | `/sessions/:id/name` | 设置会话名称 `{ name }` |
| GET | `/sessions/:id/last-response` | 获取上一条 assistant 文本 |
| POST | `/sessions/:id/export-html` | 导出 HTML `{ outputPath? }` |

---

### 生命周期

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/sessions/:id/new-session` | 新建子会话 `{ parentSession? }` |
| POST | `/sessions/:id/switch` | 切换到其他会话文件 `{ sessionPath }` |
| POST | `/sessions/:id/fork` | 从指定消息分支 `{ entryId }` |
| POST | `/sessions/:id/clone` | 克隆当前分支到新会话 |
| GET | `/sessions/:id/fork-messages` | 获取可分支的用户消息列表 |

---

## Admin Dashboard

### 管理面板

访问 `GET /admin` 返回内嵌管理面板 HTML 页面，实时展示：
- 网关上/下行指标卡片（活跃会话数、总 Prompts、总 Errors、内存使用）
- 所有会话列表（含状态、模型、消息数、内存）
- 最近 50 条事件日志
- 会话详情展开（steering queue、pending UI questions 等）

### 管理 API

管理面板下的 API 端点同样需要认证。

#### `GET /admin/api/metrics`

全局网关指标。

```json
{
  "uptime": 7200.5,
  "totalSessionsCreated": 42,
  "totalSessionsDestroyed": 38,
  "activeSessions": 4,
  "maxSessions": 50,
  "totalPrompts": 230,
  "totalErrors": 2,
  "gatewayMemoryMB": 150,
  "systemMemoryPercent": 68,
  "events": [...]
}
```

#### `GET /admin/api/sessions`

所有活跃会话快照。

```json
{
  "sessions": [{
    "sessionId": "sess_abc",
    "status": "streaming",
    "model": "deepseek-v4-pro",
    "provider": "deepseek",
    "cwd": "/workspace/project",
    "messageCount": 12,
    "pendingMessageCount": 0,
    "steeringQueue": [],
    "followUpQueue": [],
    "thinkingLevel": "xhigh",
    "autoCompactionEnabled": true,
    "autoRetryEnabled": true,
    "createdAt": 1779805000000,
    "lastActivityAt": 1779815000000,
    "memoryMB": 320,
    "pendingUiQuestions": 0
  }]
}
```

#### `GET /admin/api/sessions/:id`

单个会话详情，字段同上 `SessionSnapshot`。

---

## 资源管理

### 并发控制

`MAX_SESSIONS` (默认 50) 限制最大并发会话数。超出时 `POST /sessions` 返回 503。

### 空闲回收

会话空闲超过 `IDLE_TIMEOUT_MINUTES` 分钟（默认 30）后自动销毁。每次 SSE 事件都会重置空闲计时器。

### 单进程内存监控

每个 pi 子进程内存超 2GB 时自动驱逐，通知 SSE 客户端并记录 `ejected` 事件。

### 系统内存保护

每 30 秒检查系统总内存使用率。超过 80% 时驱逐最久未活跃的空闲会话。

### 无响应检测 (Hang Detection)

pi 子进程超过 5 分钟无 stdout 输出时，判定为 hang，发送 SIGKILL 强杀并通知 SSE 客户端。

### 优雅关闭

收到 `SIGTERM` / `SIGINT` 时：
1. 标记所有会话为 intentional shutdown
2. 关闭所有活跃 SSE 连接
3. 并发销毁所有子进程 (10s 超时)
4. 关闭 HTTP 服务器，进程退出

### SSE 心跳

每 15 秒向所有 SSE 连接发送 `: heartbeat\n\n`，防止代理/负载均衡器超时断开。

---

## 安全措施

| 措施 | 说明 |
|------|------|
| JWT 认证 | HS256 签名验证，支持过期时间 |
| CWD 白名单 | `PI_CWD_ROOT` 限制可访问目录前缀 |
| Bash 过滤 | 阻止 `rm -rf /`、`mkfs` 等危险命令 |
| Rate Limiting | 每 token 每分钟 100 请求上限 |
| Request Schema | 所有 POST/PUT 端点含 JSON Schema 入参校验 |
| CORS | 从 `CORS_ORIGIN` 环境变量读取允许来源 |
| 反向代理 | `trustProxy` 支持 `X-Forwarded-For` (可配置关闭) |
| 消息泄露 | 统一错误消息，不暴露内部异常细节 |

---

## Docker 部署

```yaml
# docker-compose.yml
services:
  pi-gateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
      - PI_CWD_ROOT=/workspace
      - MAX_SESSIONS=50
      - IDLE_TIMEOUT_MINUTES=30
    volumes:
      - ./workspace:/workspace
      - ./sessions:/var/pi-sessions
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

```bash
JWT_SECRET=your-key DEEPSEEK_API_KEY=sk-xxx docker compose up -d
```

---

## 日志

- 开发模式 (`NODE_ENV` != `production`): 彩色可读格式
- 生产模式: 结构化 JSON 行，每行含 `requestId` (8 位) 和 `sessionId`
- 日志级别由 `LOG_LEVEL` 环境变量控制
