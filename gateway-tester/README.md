# pi Gateway Tester

pi HTTP Gateway 的可视化测试前端页面。单文件 HTML，通过 HTTP/SSE 与网关交互，无需构建步骤。

## 启动方式

### 启动网关

```bash
cd pi-gateway
DISABLE_SYSTEM_MEMORY_EVICTION=true JWT_SECRET=your-secret CORS_ORIGIN='*' npx tsx src/index.ts
```

### 打开 Tester

```bash
cd gateway-tester
python3 -m http.server 8088
# 浏览器访问 http://localhost:8088
```

> 也可直接双击 `index.html` 打开（需网关设置 `CORS_ORIGIN=*` 且不含 `credentials: true`）。

## 认证

页面需要 JWT Token 才能调用网关 API。Token 使用 HS256 算法签名需与网关共享 `JWT_SECRET`。

生成 Token 示例（Node.js）：

```js
const crypto = require('crypto');
const secret = 'your-secret';
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  sub: 'dev-user',
  iat: Math.floor(Date.now()/1000),
  exp: Math.floor(Date.now()/1000) + 86400
})).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(header+'.'+payload).digest('base64url');
console.log(header+'.'+payload+'.'+sig);
```

## 界面布局

```
┌─────────────────────────────────────────────────────────┐
│ Gateway: [http://localhost:3000]  Token: [••••]  connected│ ← 工具栏
├──────────┬──────────────────────────────────────────────┤
│ Sessions │                                              │
│  [+ 新建] │   聊天输出区                                   │
│ ───────── │   （SSE 事件实时渲染）                          │
│ sess_...  │                                              │
│ sess_...  │                                              │
│           │                                              │
│ [删除会话] │                                              │
│           │ ─────────────────────────────────            │
│           │ State Models Stats Bash Config UI Messages   │ ← 快捷操作
└──────────┴──────────────────────────────────────────────┘
```

## 工具栏

| 元素 | 说明 |
|------|------|
| **Gateway URL** | 网关地址，默认 `http://localhost:3000`，修改后自动检测连接 |
| **Token** | JWT Token，输入后自动保存到 localStorage |
| **状态指示** | `connected`（绿色） / `checking...`（灰色） / `disconnected`（红色） |

连接检测：页面加载时自动 GET `/health`，修改 URL 时重新检测，每 30 秒自动重检。

## 会话面板（左侧）

### 新建会话

点击 `+` 按钮 → `POST /sessions` → 创建新的 pi RPC 会话。创建成功后自动选中并启用聊天输入。

创建时默认使用 pi 配置中的默认模型（当前为 `deepseek-v4-pro`），工作目录为网关启动时的 cwd（即 `pi-gateway/` 目录）。

### 会话列表

显示所有活跃会话，每 5 秒自动轮询更新。每个会话项显示 ID 前 16 个字符。

- **点击会话** → 切换当前选中会话，启用聊天输入
- **悬停出现 `×`** → 点击删除该会话（`DELETE /sessions/:id`）
- **蓝色边框** → 当前选中的会话

### 删除选中会话

删除当前选中的会话，如果该会话正在聊天中会先中断。

## 聊天区域（右侧上半部分）

### 消息输入

输入消息后按 **Enter** 发送，或点击 **发送** 按钮。输入框在选中会话后才启用。

### 发送 / 中断

- **发送** → `POST /sessions/:id/chat`，连接 SSE 流，实时渲染回复。发送时按钮替换为红色的 **中断** 按钮
- **中断** → 中止当前 SSE 请求（`AbortController.abort()`），同时调用 `POST /sessions/:id/abort` 通知网关中断 agent 执行

### 输出渲染

聊天输出区实时渲染 SSE 事件流，支持的事件类型：

| 事件 | 渲染样式 | 说明 |
|------|----------|------|
| `agent_start` / `agent_end` | 蓝色 `◆` 标记 | Agent 生命周期，agent_end 时显示 token 用量和费用 |
| `turn_start` / `turn_end` | 蓝色 `↻` 标记 | 单轮对话边界 |
| `message_start` / `message_end` | 蓝色 `▶` / `◼` 标记 | 消息边界 |
| `thinking_start` → `thinking_delta` → `thinking_end` | 灰色斜体 | AI 推理过程（实时流式） |
| `text_start` → `text_delta` → `text_end` | 白色正文 | AI 回复内容（实时流式） |
| `toolcall_start` → `toolcall_delta` → `toolcall_end` | 紫色背景 | 工具调用及其参数 |
| `tool_execution_start` → `tool_execution_end` | 蓝色背景 | 工具执行结果（最多显示 500 字符） |
| `compaction_start` / `compaction_end` | 灰色小字 | 上下文压缩 |
| `auto_retry_start` / `auto_retry_end` | 灰色小字 | 自动重试 |
| `queue_update` | 灰色小字 | 消息队列状态 |
| `user_question` | 橙色 `❓` 标记 | UI 交互请求（confirm/select/input/editor） |
| `notification` | 灰色 `🔔` 标记 | 通知消息 |
| `status_update` | 灰色 `📊` 标记 | 状态更新 |
| `widget_update` | 灰色 `📦` 标记 | 组件更新 |
| `title_update` | 灰色 `📝` 标记 | 标题更新 |
| `editor_text_update` | 灰色 `📄` 标记 | 编辑器文本更新 |
| `extension_error` | 红色背景 | 扩展错误 |
| `error` | 红色 `⚠` 标记 | 通用错误 |
| `: heartbeat` | 灰色 `♥` 标记 | 心跳包 |

## 快捷操作按钮（右侧底部）

每个按钮向当前选中会话的对应 API 端点发送请求，响应以 JSON 格式化在浮层中展示。

| 按钮 | HTTP 方法 | API 端点 | 说明 |
|------|-----------|----------|------|
| **State** | GET | `/sessions/:id/state` | 获取会话完整状态（模型、thinking level、流式状态、session 文件路径等） |
| **Models** | GET | `/sessions/:id/models` | 获取可用模型列表（含价格、上下文窗口、能力等） |
| **Stats** | GET | `/sessions/:id/stats` | 获取 token 用量和费用统计 |
| **Bash: echo ok** | POST | `/sessions/:id/bash` | 执行 `echo ok` 命令，返回输出和退出码 |
| **Config** | PUT | `/sessions/:id/config` | 无 body 调用配置端点（查看当前配置） |
| **Pending UI** | GET | `/sessions/:id/pending-ui-requests` | 获取待处理的 UI 交互请求列表 |
| **Messages** | GET | `/sessions/:id/messages` | 获取当前会话的全部消息历史 |

## 响应浮层

快捷操作的结果以 JSON 格式化在右侧区域的浮层中展示。浮层覆盖在聊天输出区上方。

- **标题**：显示操作名称和 HTTP 状态码（如 `STATE - HTTP 200`）
- **关闭**：点击 `×` 或按 `Escape` 键

## 数据持久化

Gateway URL 和 JWT Token 自动保存到浏览器的 `localStorage`，下次打开页面时自动填充。

## 技术实现

- **SSE 解析**：使用 `fetch` + `ReadableStream` 手动解析 SSE 帧（标准 `EventSource` 不支持 POST 方法）
- **实时流式渲染**：`thinking` 和 `text` 块采用追加模式，增量字符即时显示
- **会话轮询**：每 5 秒通过 `GET /admin/api/sessions` 刷新会话列表
- **连接检测**：页面加载时及每 30 秒通过 `GET /health` 检测网关连通性
