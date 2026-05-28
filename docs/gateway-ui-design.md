# Pi Gateway 前端应用设计方案

## 背景

需要构建一个全新的前端 Web 应用，用于与 Pi 网关 Agent 通信。前端需支持 4 种交互模式：问答、选择、补充内容、文件下载。现有 `gateway-tester/index.html` 是单文件调试工具，不适合作为正式前端。

## 核心架构

**技术栈**：React 18 + TypeScript + Vite + Zustand
**项目位置**：`pi-gateway-ui/`（与 gateway-tester 同级）

### 项目结构

```
pi-gateway-ui/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  src/
    main.tsx
    App.tsx
    api/
      client.ts                 # Gateway API 客户端（fetch + auth + SSE 解析）
      types.ts                  # 对应网关 API 的 TypeScript 类型
    stores/
      sessionStore.ts           # 会话 CRUD + 选择
      chatStore.ts              # SSE 事件处理 + 消息状态
    components/
      layout/
        Sidebar.tsx             # 会话列表、创建/删除、模型选择
        Header.tsx              # 连接状态、网关地址、Token 配置
      chat/
        ChatView.tsx            # 聊天主容器
        MessageList.tsx         # 可滚动消息列表
        MessageBubble.tsx       # 单条消息（用户/Agent）
        ChatInput.tsx           # 输入框 + 发送/中断按钮
        ThinkingBlock.tsx       # 可折叠思考块
        ToolCallBlock.tsx       # 可折叠工具调用展示
        ToolExecutionBlock.tsx  # 可折叠工具执行结果
        MarkdownRenderer.tsx    # Markdown 渲染（react-markdown + rehype-sanitize）
        FileDownloadCard.tsx    # 可点击的文件下载卡片
      widgets/
        ConfirmWidget.tsx       # 确认/取消对话框
        SelectWidget.tsx        # 单选选项列表
        InputWidget.tsx         # 文本输入框
        EditorWidget.tsx        # 多行编辑器（textarea + prefill）
        WidgetContainer.tsx     # 共享 Widget 壳（标题、结果展示）
      common/
        ConnectionStatus.tsx    # 健康检查指示器
        ErrorBoundary.tsx       # React 错误边界
    hooks/
      useSSEStream.ts           # SSE 消费自定义 Hook
      useGatewayApi.ts          # API 客户端 Hook
    utils/
      sse-parser.ts             # SSE 帧解析器
      markdown.ts               # Markdown 渲染配置
      download.ts               # 文件下载工具（Blob + URL.createObjectURL）
```

## 四种交互模式

### 1. 问答（Q&A）— `confirm` 方法

**数据流**：
```
Agent 调用 ctx.ui.confirm()
  → Pi 进程 stdout 输出 extension_ui_request(method=confirm)
  → 网关转发为 SSE user_question 事件
  → 前端渲染 ConfirmWidget
  → 用户点击 → POST /sessions/:id/ui-response { id, confirmed: true }
  → 网关写 stdin → Pi 解除阻塞
```

**前端行为**：
- 渲染两个按钮：「确认」（绿色）和「取消」（灰色）
- 快捷键：Enter = 确认，Escape = 取消
- 响应后显示结果标签，禁用按钮

### 2. 选择（Selection）— `select` 方法

**数据流**：同上，method 为 `select`，payload 含 `options` 数组。

**前端行为**：
- 渲染带序号的选项按钮列表
- 每个按钮点击后 `POST /ui-response { id, value: optionText }`
- 底部「取消」按钮
- 快捷键：数字键选择，Escape 取消

**多选说明**：`ask.ts` 扩展的多选通过 agent 侧循环 `ctx.ui.select()` 实现。每次循环生成独立的 `user_question` SSE 事件，前端只需逐个处理单选 widget，无需特殊多选逻辑。

### 3. 补充内容（Content Supplementation）— `input` / `editor` 方法

**input 方法**：
- 渲染单行文本输入框 + 提交按钮
- `placeholder` 字段设置占位文本
- Enter 提交

**editor 方法**：
- 渲染多行 `<textarea>`
- `prefill` 字段预填充内容
- 确认/取消按钮
- Cmd/Ctrl+Enter 提交，Escape 取消

### 4. 文件下载（File Downloads）

**关键问题**：网关目前没有文件服务端点。Agent 在服务端生成文件后，前端无法下载。

**解决方案**：在网关新增一个文件下载端点。

#### 网关新增端点

```
GET /sessions/:id/files/*path
```

| 项目 | 说明 |
|------|------|
| 文件 | `pi-gateway/src/routes/files.ts`（新建，~50 行） |
| 注册 | 在 `pi-gateway/src/index.ts` 添加一行路由注册 |
| 安全 | 复用 `security.ts` 的路径校验，确保在 session cwd 和 `PI_CWD_ROOT` 白名单内 |
| 响应 | 正确的 `Content-Type` + `Content-Disposition: attachment` |
| 限制 | 文件大小上限 50MB |

MIME 类型映射：

| 扩展名 | Content-Type |
|--------|-------------|
| `.md` | `text/markdown` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.pdf` | `application/pdf` |
| 其他 | `application/octet-stream` |

#### 文件交付扩展

新建 `packages/coding-agent/examples/extensions/deliver-file.ts`：

- 注册 `deliver_file` 工具，参数：`{ filePath, fileName?, mimeType? }`
- 验证文件存在后返回结构化下载标记
- Agent 文本响应中包含 `[Download: report.xlsx](/sessions/{sessionId}/files/report.xlsx)`
- 前端 Markdown 渲染器检测此 URL 模式，渲染为 `FileDownloadCard` 组件

#### FileDownloadCard 组件

- 根据扩展名显示文件图标（文档/表格/PDF）
- 显示文件名
- 点击触发 fetch → Blob → `URL.createObjectURL` → 程序化 `<a>` 点击下载
- 大文件显示下载进度
- fetch 失败时 fallback 到新标签页打开

## SSE 事件处理

### 事件类型与处理

| SSE 事件 | 来源 | 前端处理 |
|----------|------|----------|
| `agent_start` | Pi 进程 | 创建新 Agent 消息条目，设 `isStreaming: true` |
| `message_update.thinking_*` | Pi 追问 | 追加到思考缓冲区 |
| `message_update.text_*` | Pi 进程 | 追加到文本缓冲区 |
| `message_update.toolcall_*` | Pi 进程 | 跟踪工具调用状态 |
| `message_update.done` | Pi 进程 | 完成当前流，渲染 Markdown |
| `tool_execution_start` | Pi 进程 | 添加工具执行块 |
| `tool_execution_end` | Pi 进程 | 渲染工具结果 |
| `user_question` | 网关转发 | 添加到 `pendingQuestions`，渲染对应 widget |
| `notification` | 网关转发 | 信息提示行 |
| `status_update` | 网关转发 | 更新状态栏 |
| `error` | 网关/Pi | 显示错误 |
| `agent_end` | Pi 进程 | 清除流状态，设 `isStreaming: false`，关闭 SSE |

### SSE 解析

使用 `fetch` + `ReadableStream`（非 `EventSource`），因为网关 chat 端点是 POST 请求。解析逻辑从 `gateway-tester/index.html:740-761` 提取。

### 断线恢复

SSE 断开时调用 `GET /sessions/:id/pending-ui-requests` 恢复待处理的 `user_question` 状态。

## 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 状态管理 | Zustand | 比 Redux 轻量，TS 推断好，适合项目规模 |
| SSE 解析 | 手动 fetch + ReadableStream | chat 端点是 POST，EventSource 只支持 GET |
| Markdown | react-markdown + rehype-sanitize | 比 marked.js + DOMPurify 更 React 原生 |
| 样式 | CSS Modules / Tailwind | 保持与 gateway-tester 暗色主题一致 |
| 认证 | JWT → localStorage | 同 gateway-tester 模式 |

## 实施阶段

### Phase 1：网关文件端点（~50 行）
1. 新建 `pi-gateway/src/routes/files.ts`
2. 在 `index.ts` 注册路由
3. 添加 MIME 类型映射
4. 路径安全校验（复用 `security.ts`）

### Phase 2：前端脚手架
1. 初始化 Vite + React + TS 项目
2. 安装依赖：zustand, react-markdown, rehype-sanitize
3. 实现 `api/client.ts`（API 客户端 + auth）
4. 实现 `sse-parser.ts`
5. 实现 `sessionStore.ts`
6. 基础布局（Sidebar + Header + ChatView）

### Phase 3：SSE 流式渲染
1. 实现 `chatStore.ts`（完整事件处理）
2. 实现 `useSSEStream` Hook
3. 消息组件（MessageBubble, ThinkingBlock, ToolCallBlock, ToolExecutionBlock）
4. MarkdownRenderer + 文件下载链接检测
5. ChatInput（发送/中断）

### Phase 4：交互 Widget
1. WidgetContainer 共享壳
2. ConfirmWidget, SelectWidget, InputWidget, EditorWidget
3. 接入 `chatStore.pendingQuestions`
4. `POST /ui-response` 调用
5. pending question 恢复机制

### Phase 5：文件下载
1. FileDownloadCard 组件
2. 下载工具函数
3. deliver-file.ts 扩展
4. 端到端测试

## 关键参考文件

| 文件 | 参考内容 |
|------|----------|
| `pi-gateway/src/routes/chat.ts` | SSE 事件协议，所有事件类型 |
| `pi-gateway/src/routes/ui-response.ts` | UI 响应 API 契约 |
| `pi-gateway/src/security.ts` | 路径校验逻辑（文件端点需复用） |
| `gateway-tester/index.html` | SSE 解析 + widget 构建参考实现 |
| `packages/coding-agent/examples/extensions/ask.ts` | question 工具扩展 |
| `packages/coding-agent/examples/extensions/question.ts` | TUI 专属 question 扩展参考 |

## 验证方式

1. **网关端点**：`curl` 测试文件下载（合法路径返回文件，非法路径返回 403）
2. **前端基础**：启动 dev server，创建 session，发送消息验证 SSE 流渲染
3. **交互 Widget**：加载 `ask.ts` 扩展，触发 question 工具，验证 widget 渲染和响应链路
4. **文件下载**：Agent 生成文件 → tool result 含下载链接 → 前端渲染卡片 → 点击下载到本地
