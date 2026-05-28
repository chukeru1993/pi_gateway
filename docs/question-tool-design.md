# `question` 工具扩展设计方案

## 背景

Pi 现有的 `question.ts` 和 `questionnaire.ts` 扩展示例（位于 `packages/coding-agent/examples/extensions/`）使用了 `ctx.ui.custom()` 实现富 TUI 交互界面，但 `custom()` 在 RPC/网关模式下**不支持**（立即返回 `undefined`），导致这两个扩展只能在交互 TUI 模式下工作。

OpenCode 等 Agent 已内置 `question` 工具，参数 Schema 与 Pi 扩展系统高度兼容。目标是实现一个**全模式兼容**的 `question` 工具扩展，同时不修改 Pi 源码。

## 设计目标

1. **零侵入 Pi 源码**：纯扩展文件，通过 `pi -e ./ask.ts` 或 `settings.json` 加载
2. **全模式兼容**：TUI 交互模式、RPC 模式、网关/Web 模式均可用
3. **对齐 OpenCode Schema**：尽可能复用 OpenCode `question` 工具的参数结构
4. **网关零改动**：利用现有 SSE `user_question` / `POST /ui-response` 管道

## 核心洞察：跨模式 UI 原语

Pi 的 `ExtensionUIContext` 提供了多种 UI 原语，兼容性如下：

| UI 原语 | TUI 模式 | RPC 模式 | 网关模式 |
|---------|---------|---------|---------|
| `ctx.ui.custom()` | 支持（富 UI） | **不支持**（立即返回 undefined） | 不支持 |
| `ctx.ui.select()` | 支持 | **支持** | **支持** |
| `ctx.ui.input()` | 支持 | **支持** | **支持** |
| `ctx.ui.confirm()` | 支持 | **支持** | **支持** |
| `ctx.ui.editor()` | 支持 | **支持** | **支持** |

**关键结论**：使用 `select()` / `input()` / `confirm()` 即可实现全模式兼容，唯一的代价是 TUI 下 `select()` 只支持 `string[]` 标签列表，不渲染选项描述。

## 架构设计

### 基础架构（各模式统一）

```
question.execute(params, ctx)
  ├── 检查 ctx.hasUI（无 UI 返回错误）
  ├── 入口参数 Schema 校验（TypeBox）
  └── 遍历 questions[]
        ├── radioQuestion: ctx.ui.select(header, options)
        ├── multiQuestion: 循环 ctx.ui.select(header, remaining + "✓ Done")
        └── freeInput: ctx.ui.input(header, placeholder)

  收集结果 → 格式化 → 返回给 AI
```

### 工具注册清单

| 工具名 | 功能 | Schema 引用 |
|--------|------|------------|
| `question` | 单/多问题，选项选择，自定义输入 | 对齐 OpenCode `question` 参数 |

### 参数 Schema

```typescript
// 选项
const OptionSchema = Type.Object({
  label: Type.String({ description: "Display text (1-5 words, concise)" }),
  description: Type.Optional(Type.String({ description: "Explanation of choice" })),
});

// 单个问题
const QuestionSchema = Type.Object({
  question: Type.String({ description: "Complete question" }),
  header: Type.String({ description: "Very short label (max 30 chars)" }),
  options: Type.Array(OptionSchema, { description: "Available choices" }),
  multiple: Type.Optional(Type.Boolean({ description: "Allow multi-select (default: false)" })),
});

// 工具参数
const QuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});
```

## 执行流程

### 主执行体

```
execute(toolCallId, params, signal, onUpdate, ctx):
  if !ctx.hasUI → return error("Question tool requires UI")
  if params.questions.length === 0 → return error("No questions")

  answers = []
  for each q in params.questions:
    options = renderOptions(q.options)

    if q.multiple:
      answer = await runMultiSelect(ctx, q.header, options, signal)
    else:
      answer = await runSingleSelect(ctx, q.header, options, signal)

    if answer === null → user cancelled → return cancelled result
    answers.push(buildAnswer(q, answer))

  return formatResult(questions, answers)
```

### 渲染选项标签

由于 `ctx.ui.select()` 只接受 `string[]`（无描述字段），选项描述需要拼入标签：

```
renderOptions(options):
  return options.map((opt, i) =>
    opt.description
      ? `${i + 1}. ${opt.label} — ${opt.description}`
      : `${i + 1}. ${opt.label}`
  )
```

### 单选（radioQuestion）

```
runSingleSelect(ctx, header, options):
  selected = await ctx.ui.select(header, options, { timeout: 60000 })
  if selected === undefined → return null             // 用户取消
  return parsePick(selected)                          // 解析序号
```

### 多选（multiQuestion）

`ctx.ui.select()` 仅支持单选，需要通过循环 + `Done` 选项实现多选：

```
runMultiSelect(ctx, header, options):
  picked = []
  remaining = [...options]

  loop:
    choices = [...remaining, "✓ Done"]
    selected = await ctx.ui.select(header, choices, { timeout: 60000 })

    if selected === undefined → return null          // 用户取消
    if selected === "✓ Done" → break
    picked.push(selected)
    remove selected from remaining

    if remaining.length === 0 → break                // 全部选完

  return picked
```

### 返回格式

```typescript
// content 会被注入到对话上下文
{
  content: [{
    type: "text",
    text: `User has answered your questions:
"${question1}" = "选项A, 自定义输入"
"${question2}" = "选项B"
You can now continue with the user's answers in mind.`
  }],
  details: {
    answers: [
      { question: "...", header: "...", values: ["选项A"], cancelled: false },
      ...
    ],
    cancelled: false
  }
}
```

## 各模式具体行为

### TUI 模式

| 步骤 | 行为 |
|------|------|
| `ctx.ui.select()` | 渲染 `ExtensionSelectorComponent`，箭头 + 回车选择 |
| 多选循环 | 弹出多个选择器，逐个选择，最后 `✓ Done` 结束 |
| 取消 | Escape → 返回 `undefined` |

### RPC 模式

| 步骤 | 行为 |
|------|------|
| `ctx.ui.select()` | JSONL stdout 发出 `extension_ui_request(method=select, title, options)`，阻塞等待 stdin 的 `extension_ui_response` |
| 多选循环 | 连续发出多个 `extension_ui_request`，逐个等待响应 |
| 取消 | `extension_ui_response(cancelled: true)` → 返回 `undefined` |

### 网关/Web 模式

| 步骤 | 行为 |
|------|------|
| `ctx.ui.select()` | `extension_ui_request` → SSE `user_question` 事件推送到浏览器 |
| 浏览器回答 | `POST /sessions/:id/ui-response { id, value }` → 写入 pi 子进程 stdin |
| 多选循环 | 多个 `user_question` SSE 事件连续推送，浏览器依次回答 |

## 网关兼容性

### 网关已有基础设施（无需改动）

| 组件 | 文件 | 作用 |
|------|------|------|
| SSE `user_question` 事件 | `pi-gateway/src/routes/chat.ts:49-66` | 转发 `extension_ui_request` 到浏览器 |
| UI 响应 API | `pi-gateway/src/routes/ui-response.ts` | `POST /sessions/:id/ui-response` 接收浏览器回答 |
| 待处理问题跟踪 | `pi-gateway/src/pi-process.ts:53,262-272` | `pendingUiRequests` Map 管理问题生命周期 |
| 进程池管理 | `pi-gateway/src/pi-process-pool.ts` | 超时回收、内存驱逐 |

### 网关配置方式

扩展可通过两种方式加载：

**方式一**（全局，`~/.pi/agent/settings.json`）：
```json
{
  "extensions": ["/path/to/extensions/ask.ts"]
}
```

**方式二**（项目级，`.pi/settings.json`）：
```json
{
  "extensions": ["./extensions/ask.ts"]
}
```

**方式三**（CLI 参数，创建 pi 子进程时）：
```bash
pi --mode rpc --extensions /path/to/extensions/ask.ts
```

## 文件清单

```
packages/coding-agent/examples/extensions/ask.ts  ← 新建
```

不修改任何 Pi 源码文件。

## 与现有扩展的关系

| 文件 | 核心原语 | TUI | RPC | 网关 | 用途 |
|------|---------|-----|-----|------|------|
| `question.ts` | `ctx.ui.custom()` | 支持 | 不支持 | 不支持 | TUI 专属，富 UI |
| `questionnaire.ts` | `ctx.ui.custom()` | 支持 | 不支持 | 不支持 | TUI 专属，多问题 tabs |
| **`ask.ts`（新）** | `ctx.ui.select()` / `input()` | **支持** | **支持** | **支持** | 全模式通用 |

三者独立，可按需加载不冲突，也可同时加载并存。

## 代码量估算

| 模块 | 预估行数 |
|------|----------|
| TypeBox Schema 定义 | ~30 |
| `renderOptions` / `parsePick` 辅助函数 | ~30 |
| `runSingleSelect` / `runMultiSelect` 执行函数 | ~70 |
| `execute` 主逻辑 | ~50 |
| `renderCall` / `renderResult`（TUI 渲染） | ~40 |
| 扩展工厂 + `registerTool` 注册 | ~20 |
| **合计** | **~240 行** |

## 可选增强（不阻塞首版）

1. **自定义输入**：每个问题自动追加 `"✎ Type your own..."` 选项，选中后调用 `ctx.ui.input()`
2. **超时配置**：通过参数传递自定义超时（默认 60s）
3. **取消回退**：用户取消当前问题时提供"跳过"vs"取消全部"选项
4. **TUI 模式检测**：如果 `custom()` 可用，优先用 `custom()` 提供更丰富 UI（描述渲染、多 co-问题间 tab 导航），fallback 到 `select()`
5. **确认（confirm）原语**：对于是/否类问题，使用 `ctx.ui.confirm()` 更简洁
