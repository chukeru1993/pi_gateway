# pi HTTP Gateway — API 接口文档

## 基础信息

- **Base URL**: `http://<host>:<port>` (端口通过 `GATEWAY_PORT` 或 `PORT` 环境变量配置，默认 `3000`)
- **认证方式**: `Authorization: Bearer <jwt_token>` (所有端点，`/health` 除外)
- **Content-Type**: `application/json`

---

## 1. 认证

### 获取 Token

网关使用 HS256 JWT 认证，需与网关共享 `JWT_SECRET` 密钥。

**JWT Payload**:
```json
{
  "sub": "<user_id>",
  "iat": 1700000000,
  "exp": 1700086400
}
```

### 无 Token / Token 无效

```
HTTP 401
{"error": "Unauthorized"}
```

---

## 2. 健康检查

### `GET /health`

无需认证。

**Response** `200`:
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

## 3. 会话生命周期

### `POST /sessions`

创建会话，启动 pi 子进程。

**Request**:
```json
{
  "provider": "deepseek",       // 可选
  "model": "deepseek-v4-pro",   // 可选
  "cwd": "/workspace/project",  // 可选，须在白名单内
  "noSession": false,           // 可选
  "sessionDir": "/path/to/sessions", // 可选
  "thinkingLevel": "medium"     // 可选: "low" | "medium" | "high"
}
```

**Response** `201`:
```json
{
  "sessionId": "sess_abc123def",
  "status": "ready"
}
```

**错误**:
| 状态码 | 说明 |
|--------|------|
| 400 | `cwd` 不在白名单内 |
| 503 | 并发会话数达到上限 |

---

### `GET /sessions/:id/state`

获取会话状态。

**Response** `200`:
```json
{
  "model": {
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "reasoning": true,
    "input": ["text"],
    "cost": { "input": 0.435, "output": 0.87, "cacheRead": 0.003625, "cacheWrite": 0 },
    "contextWindow": 1000000,
    "maxTokens": 384000
  },
  "thinkingLevel": "xhigh",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all",
  "followUpMode": "all",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "pendingMessageCount": 0,
  "sessionFile": "/path/to/session.jsonl",
  "sessionId": "019e64b0...",
  "sessionName": "my-feature"
}
```

---

### `GET /sessions/:id/stats`

获取 token 和费用统计。

**Response** `200`:
```json
{
  "sessionFile": "/path/to/session.jsonl",
  "sessionId": "019e64b0...",
  "userMessages": 5,
  "assistantMessages": 5,
  "toolCalls": 3,
  "toolResults": 3,
  "totalMessages": 10,
  "tokens": {
    "input": 12000,
    "output": 800,
    "cacheRead": 0,
    "cacheWrite": 0,
    "total": 12800
  },
  "cost": 0.005916,
  "contextUsage": {
    "tokens": 12800,
    "contextWindow": 1000000,
    "percent": 1.28
  }
}
```

---

### `DELETE /sessions/:id`

销毁会话，关闭 pi 子进程。

**Response** `200`:
```json
{ "ok": true }
```

**错误**:
| 状态码 | 说明 |
|--------|------|
| 404 | 会话不存在 |

---

## 4. 对话

### `POST /sessions/:id/chat` — SSE 流

发送消息，接收 SSE 事件流。

> 此端点返回 `text/event-stream`，标准 `EventSource` 不支持 POST 方法。前端需使用 `fetch` + `ReadableStream` 手动解析 SSE 帧。

**Request**:
```json
{
  "message": "解释这个代码库的架构",
  "images": [
    { "type": "image", "data": "<base64>", "mimeType": "image/png" }
  ],
  "streamingBehavior": "steer"
}
```

**Request 字段**:

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 消息内容，最小 1 字符 |
| `images` | array | 否 | 图片数组 |
| `streamingBehavior` | string | 否 | `"steer"` 或 `"followUp"` |

**Response** `200` — SSE 文本流:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**错误**:
| 状态码 | 说明 |
|--------|------|
| 400 | `message` 字段缺失 |
| 404 | 会话不存在 |
| 409 | 该会话已有活跃 SSE 连接 |

---

### SSE 事件参考

#### 消息流

```
agent_start
  turn_start
    message_start
      message_update  { assistantMessageEvent: { type: "thinking_start", ... } }
      message_update  { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "我正在" } }
      message_update  { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考" } }
      message_update  { assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "我正在思考" } }
      message_update  { assistantMessageEvent: { type: "text_start", contentIndex: 1 } }
      message_update  { assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "这是" } }
      message_update  { assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "回复" } }
      message_update  { assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "这是回复" } }
      message_update  { assistantMessageEvent: { type: "done", reason: "stop" } }
    message_end
  turn_end
agent_end
```

#### `message_update` 子类型

| assistantMessageEvent.type | 说明 | 关键字段 |
|---|---|---|
| `thinking_start` | 思考块开始 | `contentIndex` |
| `thinking_delta` | 思考增量 | `contentIndex`, `delta` |
| `thinking_end` | 思考块结束 | `contentIndex`, `content` |
| `text_start` | 文本块开始 | `contentIndex` |
| `text_delta` | 文本增量 | `contentIndex`, `delta` |
| `text_end` | 文本块结束 | `contentIndex`, `content` |
| `toolcall_start` | 工具调用开始 | `contentIndex`, `toolCall: { id, name, arguments }` |
| `toolcall_delta` | 工具调用参数增量 | `contentIndex`, `delta` |
| `toolcall_end` | 工具调用结束 | `contentIndex`, `toolCall: { id, name, arguments }` |
| `done` | 消息完成 | `reason: "stop" \| "toolUse" \| "maxTokens" \| "refusal"` |

#### 工具执行

```
tool_execution_start
  tool_execution_update
tool_execution_end
```

| event | data 字段 |
|-------|---------|
| `tool_execution_start` | `{ toolCallId, toolName, args }` |
| `tool_execution_update` | `{ toolCallId, toolName, args, partialResult }` |
| `tool_execution_end` | `{ toolCallId, toolName, result, isError }` |

#### UI 请求 — 需要前端应答

```
user_question  { id, method: "confirm"|"select"|"input"|"editor", title, ... }
```

| method | 额外字段 |
|--------|---------|
| `confirm` | `message?`, `timeout?` |
| `select` | `options[]`, `timeout?` |
| `input` | `placeholder?`, `timeout?` |
| `editor` | `prefill?` |

收到 `user_question` 后，前端应答通过 `POST /sessions/:id/ui-response`。

#### UI 请求 — 即发即弃（无需应答）

| event | data |
|-------|------|
| `notification` | `{ id, message, notifyType: "info"\|"warning"\|"error" }` |
| `status_update` | `{ id, statusKey, statusText }` |
| `widget_update` | `{ id, widgetKey, widgetLines, widgetPlacement? }` |
| `title_update` | `{ id, title }` |
| `editor_text_update` | `{ id, text }` |

#### 其他事件

| event | data |
|-------|------|
| `compaction_start` | `{ reason }` |
| `compaction_end` | `{ reason, result, aborted, willRetry }` |
| `auto_retry_start` | `{ attempt, maxAttempts, delayMs, errorMessage }` |
| `auto_retry_end` | `{ success, attempt }` |
| `queue_update` | `{ steering: string[], followUp: string[] }` |
| `extension_error` | `{ extensionPath, event, error }` |

#### 心跳和错误

```
event: error  → { message: "..." }
event:         ← : heartbeat (每 15s，无 event 字段，前端忽略)
```

---

### `POST /sessions/:id/steer`

流式中途追加指令。

**Request**:
```json
{ "message": "Focus on error handling" }
```

**Response** `200`: `{ "ok": true }`

---

### `POST /sessions/:id/follow-up`

追加后续消息。

**Request**:
```json
{ "message": "Also check the logs" }
```

**Response** `200`: `{ "ok": true }`

---

### `POST /sessions/:id/abort`

中断当前执行。无 Body。

**Response** `200`: `{ "ok": true }`

---

## 5. UI 交互应答

### `POST /sessions/:id/ui-response`

应答 `user_question` SSE 事件。

**Request** (三选一):
```json
// confirm 应答
{ "id": "uuid-1", "confirmed": true }

// select / input / editor 应答
{ "id": "uuid-2", "value": "Allow" }

// 取消
{ "id": "uuid-3", "cancelled": true }
```

`confirmed`、`value`、`cancelled` 必须精确提供一个。

**Response** `200`: `{ "ok": true }`

**错误**:
| 状态码 | 说明 |
|--------|------|
| 400 | 未提供 `confirmed`/`value`/`cancelled` 或提供了多个 |
| 404 | 会话不存在 |

---

### `GET /sessions/:id/pending-ui-requests`

查询当前待处理的 UI 请求。SSE 连接断开重连后，前端通过此端点恢复 `user_question` 状态。

**Response** `200`:
```json
{
  "questions": [
    {
      "id": "uuid-1",
      "method": "confirm",
      "title": "Allow dangerous command?",
      "message": "rm -rf /tmp/build",
      "timeout": 10000
    }
  ]
}
```

---

## 6. 模型与配置

### `GET /sessions/:id/models`

获取可用模型列表。

**Response** `200`:
```json
{
  "models": [
    {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "api": "openai-completions",
      "provider": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "reasoning": true,
      "thinkingLevelMap": { "minimal": null, "low": null, "medium": null, "high": "high", "xhigh": "max" },
      "input": ["text"],
      "cost": { "input": 0.435, "output": 0.87, "cacheRead": 0.003625, "cacheWrite": 0 },
      "contextWindow": 1000000,
      "maxTokens": 384000
    }
  ]
}
```

---

### `PUT /sessions/:id/model`

切换模型。

**Request**:
```json
{ "provider": "deepseek", "modelId": "deepseek-v4-pro" }
```

**Response** `200` — 返回新模型对象。

---

### `POST /sessions/:id/cycle-model`

循环切换到下一个可用模型。无 Body。

**Response** `200` — 返回 `{ model, thinkingLevel, isScoped }`。

---

### `PUT /sessions/:id/thinking-level`

设置思考级别。

**Request**:
```json
{ "level": "medium" }
```

**Response** `200`: `{ "ok": true }`

---

### `POST /sessions/:id/cycle-thinking-level`

循环切换思考级别。无 Body。

**Response** `200` — 返回 `{ level }`。

---

### `PUT /sessions/:id/config`

批量配置。

**Request** (所有字段可选):
```json
{
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "autoCompactionEnabled": true,
  "autoRetryEnabled": true
}
```

**Response** `200`: `{ "ok": true }`

---

## 7. 会话操作

| 方法 | 路径 | Request Body | Response |
|------|------|-------------|----------|
| GET | `/sessions/:id/messages` | — | `{ messages: [...] }` |
| POST | `/sessions/:id/compact` | `{ "customInstructions": "..." }` | CompactionResult |
| POST | `/sessions/:id/bash` | `{ "command": "ls -la" }` | `{ output, exitCode, cancelled, truncated }` |
| POST | `/sessions/:id/abort-bash` | — | `{ "ok": true }` |
| GET | `/sessions/:id/commands` | — | `{ commands: [...] }` |
| PUT | `/sessions/:id/name` | `{ "name": "my-session" }` | `{ "ok": true }` |
| GET | `/sessions/:id/last-response` | — | `{ text: "..." }` |
| POST | `/sessions/:id/export-html` | `{ "outputPath": "/tmp/out.html" }` | `{ path: "..." }` |

---

## 8. 会话生命周期

| 方法 | 路径 | Request Body | Response |
|------|------|-------------|----------|
| POST | `/sessions/:id/new-session` | `{ "parentSession": "..." }` | 结果对象 |
| POST | `/sessions/:id/switch` | `{ "sessionPath": "/path/to/session.jsonl" }` | 结果对象 |
| POST | `/sessions/:id/fork` | `{ "entryId": "msg_001" }` | `{ text, cancelled? }` |
| POST | `/sessions/:id/clone` | — | `{ cancelled? }` |
| GET | `/sessions/:id/fork-messages` | — | `{ messages: [...] }` |

---

## 9. Admin API

以下端点位于 `/admin` 前缀下，需认证。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin` | 管理面板 HTML 页面 |
| GET | `/admin/api/metrics` | 全局网关指标 |
| GET | `/admin/api/sessions` | 所有活跃会话快照 |
| GET | `/admin/api/sessions/:id` | 单个会话详情 |

### `GET /admin/api/metrics`

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
  "events": [
    { "timestamp": 1779805000000, "sessionId": "sess_abc", "type": "created",  "detail": "provider=- model=-" },
    { "timestamp": 1779805100000, "sessionId": "sess_abc", "type": "prompt",   "detail": "解释代码库" },
    { "timestamp": 1779805300000, "sessionId": "sess_abc", "type": "destroyed","detail": "explicit delete" }
  ]
}
```

**Event 类型**: `created` | `destroyed` | `prompt` | `error` | `crashed` | `compaction` | `ejected`

### `GET /admin/api/sessions`

```json
{
  "sessions": [{
    "sessionId": "sess_abc",
    "status": "streaming" | "idle" | "compacting",
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

---

## 10. 前端 SSE 消费示例

```typescript
async function chatStream(sessionId: string, message: string, token: string): Promise<void> {
  const res = await fetch(`http://localhost:3000/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) throw new Error(await res.text());

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // 解析 SSE 帧: "event: <type>\ndata: <json>"
      const eventMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;

      const eventType = eventMatch[1];
      const payload = JSON.parse(dataMatch[1]);

      // 按事件类型处理
      switch (eventType) {
        case "agent_start":
          console.log("Agent started");
          break;
        case "message_update": {
          const sub = payload.assistantMessageEvent;
          if (sub.type === "text_delta") process.stdout.write(sub.delta);
          if (sub.type === "thinking_delta") process.stdout.write(colors.dim(sub.delta));
          break;
        }
        case "user_question":
          console.log("UI request:", payload.method, payload.title);
          // 前端展示对话框 → 用户应答 → POST /ui-response
          break;
        case "error":
          console.error("Error:", payload.message);
          break;
        case "agent_end":
          console.log("\nDone");
          return;
      }
    }
  }
}
```
