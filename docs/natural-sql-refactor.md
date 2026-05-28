# NaturalSQL 改造方案：接入 Pi Gateway Agent

## 1. 背景

### 1.1 现状

NaturalSQL 是自然语言转 SQL 的 Web 应用（FastAPI + Vue 3 + SQL Server 2022）。当前通过 `generate_service.py` 编排 7 步 LLM 提示链：

```
语义分析 → 术语映射 → 示例匹配 → 表结构选择 → SQL构建 → 验证 → 输出
```

每步：拼接提示词 → 调用 DeepSeek API → 解析 JSON → 传给下一步。

### 1.2 问题

- 管道僵化，各步骤孤立推理，无法自我纠错
- JSON 解析脆弱（4 种提取策略）
- 决策点硬编码（仅 3 个固定检查点）
- 提示词模板维护成本高（7 个模块）

### 1.3 目标

用 Pi Gateway Agent 替代整个 7 步管道。Agent 通过工具调用自主完成全部推理，NaturalSQL 后端变为薄代理，前端通过 SSE 接收实时事件。

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────┐     HTTP/SSE      ┌───────────────┐     JSONL/SSE     ┌──────────────┐
│  Vue 前端    │ ◄──────────────── │  FastAPI 后端  │ ◄──────────────── │  Pi Gateway  │
│  （CRUD）    │                   │  （薄代理）    │                   │  + Agent     │
└──────┬──────┘                   └───────────────┘                   └──────┬───────┘
       │                                                                     │
       │ CRUD 操作                                                   Agent Skill 自主检索
       ▼                                                                     ▼
┌──────────────┐    定时同步     ┌──────────────┐                   ┌──────────────┐
│  SQL Server  │ ─────────────→ │  MD 文件      │ ◄──────────────── │  知识库文件   │
│  （知识库）   │                │  seeds/       │                   │              │
└──────────────┘                └──────────────┘                   └──────────────┘
```

### 2.2 一次完整调用流程

```
1. 用户输入自然语言 + 可选模板字段
2. 前端 POST /api/generate → 后端创建 GenHistory + 网关会话
3. 前端 GET /api/generate/{id}/stream → 后端向网关 POST /sessions/:id/chat
4. 网关返回 SSE 流，后端透传到前端：
   ├─ agent_start → 前端创建 Agent 消息容器
   ├─ message_update (thinking) → 显示 Agent 思考过程
   ├─ tool_execution_start (bash/query_tables/...) → 显示工具调用
   ├─ tool_execution_end → 显示工具结果
   ├─ message_update (text) → 显示 Agent 文本输出
   ├─ user_question (select/confirm/input) → 前端弹出交互 widget
   │   └─ 用户操作 → POST /api/generate/{id}/ui-response → 后端转发到网关
   ├─ Agent 生成文件 → 前端渲染下载链接
   └─ agent_end → 提取最终结果，展示 ResultTabs
```

### 2.3 与现有架构的对比

| 维度 | 现有方案 | 新方案 |
|------|----------|--------|
| LLM 调用 | 后端 7 次独立调用 DeepSeek | 网关 1 次会话，Agent 自主多轮 |
| 推理编排 | 后端代码硬编码 7 步 | Agent 自主决策调用工具 |
| 知识注入 | 每步提示词中拼接上下文 | Agent Skill 自主从 MD 文件检索，后端不参与 |
| 决策点 | 3 个硬编码检查点 | Agent 动态判断何时提问 |
| 结果格式 | 每步解析 JSON | 从 Agent 最终输出中提取 |
| 通信协议 | WebSocket | SSE |
| 文件生成 | 不支持 | Agent 可生成文件并提供下载 |

---

## 3. 知识库

### 3.1 知识库架构

```
前端 CRUD（Vue） → SQL Server（sys_table, sys_term_dictionary, sys_query_example）
                         │
                         │ 定时同步
                         ▼
                   MD 文件（seeds/ 目录）
                         │
                         │ Agent Skill 自主检索
                         ▼
                   Pi Agent 生成 SQL
```

知识库由前端维护（表结构、术语词典、查询示例的 CRUD 操作），存储在 SQL Server 中。定时同步任务将数据库内容导出为 MD 格式文件，存放于 Agent Skill 可访问的目录。

**Agent Skill 自主从 MD 文件中检索相关内容**，后端不需要组装知识库到提示词中。

### 3.2 后端提示词组装

后端只需组装用户输入 + 模板字段，不涉及知识库内容：

```python
def build_prompt_message(history):
    """组装发送给 Agent 的消息（仅用户输入 + 模板字段）"""
    parts = []

    # 用户输入
    parts.append(history.input_text)

    # 模板字段（如果有）
    if history.template_fields:
        fields = json.loads(history.template_fields)
        parts.append("\n模板字段需求：")
        for f in fields:
            nullable = "[不可空]" if f.get("nullable") == "否" else "[可空]"
            parts.append(f"- {f['desc']}（字段名：{f['name']}）{nullable}")

    return "\n".join(parts)
```

### 3.3 知识库同步（暂不做）

> **暂不实现**。当前阶段手动维护 MD 文件，后续再做自动同步。

需要新增一个同步服务，将 SQL Server 中的知识库数据定时导出为 MD 文件：

| 数据源 | MD 文件 | 同步频率 |
|--------|---------|----------|
| `sys_table` + `sys_table_column` | `tables.md` | 数据变更时 |
| `sys_term_dictionary` | `terms.md` | 数据变更时 |
| `sys_query_example` + `sys_query_example_table` | `examples.md` | 数据变更时 |

同步触发方式：CRUD 操作后触发、定时任务（如每 5 分钟）、或手动触发。

---

## 4. 网关交互协议

### 4.1 创建会话

```
POST http://localhost:3000/sessions
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "provider": "deepseek",
  "model": "deepseek-chat"
}
```

响应：
```json
{
  "sessionId": "sess_a1b2c3d4e5f6",
  "status": "ready"
}
```

### 4.2 发送消息（SSE 流）

```
POST http://localhost:3000/sessions/sess_a1b2c3d4e5f6/chat
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "message": "## 用户需求\n查询本月各科室门诊量\n\n## 相关表结构\n### OP_Register — 门诊挂号\n..."
}
```

响应：`Content-Type: text/event-stream`

```
event: agent_start
data: {}

event: message_update
data: {"assistantMessageEvent": {"type": "thinking_start"}}

event: message_update
data: {"assistantMessageEvent": {"type": "thinking_delta", "delta": "用户想查询..."}}

event: message_update
data: {"assistantMessageEvent": {"type": "thinking_end"}}

event: tool_execution_start
data: {"toolName": "bash", "args": {"command": "..."}}

event: tool_execution_end
data: {"toolName": "bash", "result": {...}}

event: message_update
data: {"assistantMessageEvent": {"type": "text_start"}}

event: message_update
data: {"assistantMessageEvent": {"type": "text_delta", "delta": "根据分析..."}}

event: message_update
data: {"assistantMessageEvent": {"type": "text_end", "content": "完整文本"}}

event: user_question
data: {"id": "uuid-xxx", "method": "select", "title": "字段归属", "options": ["OP_Register.DeptCode", "SYS_Dept.DeptCode"]}

event: agent_end
data: {"messages": [...]}
```

### 4.3 回复用户问题

```
POST http://localhost:3000/sessions/sess_a1b2c3d4e5f6/ui-response
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "id": "uuid-xxx",
  "value": "OP_Register.DeptCode"
}
```

### 4.4 中止会话

```
POST http://localhost:3000/sessions/sess_a1b2c3d4e5f6/abort
Authorization: Bearer {JWT_TOKEN}
```

### 4.5 销毁会话

```
DELETE http://localhost:3000/sessions/sess_a1b2c3d4e5f6
Authorization: Bearer {JWT_TOKEN}
```

---

## 5. 后端设计

### 5.1 删除清单

| 文件 | 行数（约） | 原因 |
|------|-----------|------|
| `app/services/generate_service.py` | ~500 | 7 步编排器，被 Agent 替代 |
| `app/prompts/step1_semantic.py` | ~80 | 提示模板 |
| `app/prompts/step2_term_value.py` | ~80 | 提示模板 |
| `app/prompts/step3_example_match.py` | ~80 | 提示模板 |
| `app/prompts/step4_table_select.py` | ~80 | 提示模板 |
| `app/prompts/step5_sql_build.py` | ~80 | 提示模板 |
| `app/prompts/step6_verify.py` | ~80 | 提示模板 |
| `app/prompts/step7_output.py` | ~80 | 提示模板 |
| `app/llm/base.py` | ~30 | LLM 抽象基类 |
| `app/llm/openai_llm.py` | ~60 | OpenAI 兼容 LLM |
| `app/llm/factory.py` | ~20 | LLM 工厂 |
| `app/ws/generate_ws.py` | ~80 | WebSocket 管理器 |
| **合计** | **~1240** | |

### 5.2 新增文件

#### `backend/app/services/knowledge_sync.py`（暂不做）

> **暂不实现**。当前阶段手动维护 MD 文件，后续再做自动同步。

知识库同步服务，将 SQL Server 数据导出为 MD 文件供 Agent Skill 检索：

```python
class KnowledgeSyncService:
    """将知识库从 SQL Server 同步到 MD 文件"""

    def sync_tables(self, db: Session, output_dir: str):
        """导出表结构为 tables.md"""
        ...

    def sync_terms(self, db: Session, output_dir: str):
        """导出术语词典为 terms.md"""
        ...

    def sync_examples(self, db: Session, output_dir: str):
        """导出查询示例为 examples.md"""
        ...

    def sync_all(self, db: Session, output_dir: str):
        """全量同步"""
        ...
```

触发方式：
- CRUD 操作后调用 `sync_all()`
- 定时任务（APScheduler，每 5 分钟）
- 手动触发（管理 API）

#### `backend/app/gateway/client.py`

```python
import httpx
import json
from typing import AsyncIterator

class GatewayClient:
    """Pi Gateway HTTP 客户端"""

    def __init__(self, base_url: str, jwt_token: str):
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {jwt_token}",
            "Content-Type": "application/json",
        }

    async def create_session(self, provider: str = "deepseek", model: str = "deepseek-chat") -> str:
        """创建网关会话，返回 session_id"""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/sessions",
                headers=self.headers,
                json={"provider": provider, "model": model},
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json()["sessionId"]

    async def chat_stream(self, session_id: str, message: str) -> AsyncIterator[dict]:
        """发送消息并返回 SSE 事件流"""
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/sessions/{session_id}/chat",
                headers=self.headers,
                json={"message": message},
                timeout=600,  # Agent 可能需要较长时间
            ) as resp:
                resp.raise_for_status()
                event_type = None
                async for line in resp.aiter_lines():
                    if line.startswith("event: "):
                        event_type = line[7:]
                    elif line.startswith("data: ") and event_type:
                        try:
                            data = json.loads(line[6:])
                            yield {"type": event_type, "data": data}
                        except json.JSONDecodeError:
                            pass
                        event_type = None

    async def send_ui_response(self, session_id: str, request_id: str, response: dict) -> None:
        """回复用户问题"""
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{self.base_url}/sessions/{session_id}/ui-response",
                headers=self.headers,
                json={"id": request_id, **response},
                timeout=30,
            )

    async def abort(self, session_id: str) -> None:
        """中止当前 Agent 轮次"""
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{self.base_url}/sessions/{session_id}/abort",
                headers=self.headers,
                timeout=10,
            )

    async def destroy(self, session_id: str) -> None:
        """销毁网关会话"""
        async with httpx.AsyncClient() as client:
            await client.delete(
                f"{self.base_url}/sessions/{session_id}",
                headers=self.headers,
                timeout=10,
            )
```

#### `backend/app/gateway/prompt_builder.py`

```python
def build_prompt_message(history) -> str:
    """组装发送给 Agent 的消息（仅用户输入 + 模板字段）"""
    parts = []

    # 用户输入
    parts.append(history.input_text)

    # 模板字段（如果有）
    if history.template_fields:
        fields = json.loads(history.template_fields)
        parts.append("\n模板字段需求：")
        for f in fields:
            nullable = "[不可空]" if f.get("nullable") == "否" else "[可空]"
            parts.append(f"- {f['desc']}（字段名：{f['name']}）{nullable}")

    return "\n".join(parts)
```

### 5.3 修改 `app/routers/generate.py`

#### `POST /api/generate` — 创建任务

```python
@router.post("")
async def create_task(
    req: GenerateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # 1. 创建 GenHistory 记录
    history = GenHistory(
        user_id=current_user.id,
        input_text=req.input_text,
        template_fields=json.dumps(req.template_fields) if req.template_fields else None,
        status="running",
    )
    db.add(history)
    db.commit()
    db.refresh(history)

    # 2. 创建网关会话
    gateway = get_gateway_client()
    session_id = await gateway.create_session()

    # 3. 存储映射关系
    store_session_mapping(history.id, session_id)

    # 4. 组装提示词（仅用户输入 + 模板字段，知识库由 Agent 自行检索）
    message = build_prompt_message(history)

    # 5. 异步启动 Agent 对话（不等待完成）
    asyncio.create_task(run_agent_task(history.id, session_id, message, db))

    return {"history_id": history.id, "gateway_session_id": session_id}
```

#### `GET /api/generate/{id}/stream` — SSE 代理

```python
@router.get("/{history_id}/stream")
async def stream_generate(
    history_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_id = get_session_mapping(history_id)
    if not session_id:
        raise HTTPException(404, "会话不存在")

    gateway = get_gateway_client()

    async def event_generator():
        try:
            async for event in gateway.chat_stream(session_id, ""):
                # 透传 SSE 事件
                yield f"event: {event['type']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"

                # agent_end 时更新历史记录
                if event["type"] == "agent_end":
                    await finalize_task(history_id, event["data"], db)
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

#### `POST /api/generate/{id}/ui-response` — 转发决策

```python
@router.post("/{history_id}/ui-response")
async def forward_ui_response(
    history_id: int,
    req: UIResponseRequest,
    current_user: User = Depends(get_current_user),
):
    session_id = get_session_mapping(history_id)
    if not session_id:
        raise HTTPException(404, "会话不存在")

    gateway = get_gateway_client()
    await gateway.send_ui_response(session_id, req.id, req.dict(exclude={"id"}))
    return {"ok": True}
```

#### `POST /api/generate/{id}/abort` — 中止任务

```python
@router.post("/{history_id}/abort")
async def abort_task(
    history_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_id = get_session_mapping(history_id)
    if not session_id:
        raise HTTPException(404, "会话不存在")

    gateway = get_gateway_client()
    await gateway.abort(session_id)
    await gateway.destroy(session_id)

    # 更新历史记录
    history = db.query(GenHistory).get(history_id)
    history.status = "cancelled"
    db.commit()

    clear_session_mapping(history_id)
    return {"message": "已中止"}
```

### 5.4 新增 Schema

```python
# app/schemas/generate_v2.py

class UIResponseRequest(BaseModel):
    id: str           # 网关 user_question 的 id
    value: Optional[str] = None
    confirmed: Optional[bool] = None
    cancelled: Optional[bool] = None
```

### 5.5 配置新增

```python
# app/config.py 新增

GATEWAY_URL: str = "http://localhost:3000"
GATEWAY_JWT_TOKEN: str = ""
GATEWAY_PROVIDER: str = "deepseek"
GATEWAY_MODEL: str = "deepseek-chat"
```

### 5.6 会话映射存储

使用内存字典（简单方案）或 Redis（生产方案）：

```python
# app/gateway/session_store.py

_session_map: dict[int, str] = {}  # history_id -> gateway_session_id

def store_session_mapping(history_id: int, session_id: str):
    _session_map[history_id] = session_id

def get_session_mapping(history_id: int) -> str | None:
    return _session_map.get(history_id)

def clear_session_mapping(history_id: int):
    _session_map.pop(history_id, None)
```

---

## 6. 前端设计

### 6.1 删除清单

| 文件 | 原因 |
|------|------|
| `composables/useWebSocket.js` | WebSocket，改为 SSE |
| `components/sqlgen/StepProgress.vue` | 7 步进度条，被 AgentActivity 替代 |

### 6.2 新增 `composables/useSSE.js`

```javascript
import { ref, onUnmounted } from 'vue'

export function useSSE() {
  const isStreaming = ref(false)
  const events = ref([])
  let abortController = null
  let eventHandlers = {}

  function onEvent(type, handler) {
    eventHandlers[type] = handler
  }

  async function connect(url, token) {
    abortController = new AbortController()
    isStreaming.value = true
    events.value = []

    try {
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: abortController.signal,
      })

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let eventType = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        while (true) {
          buf = buf.replace(/\r\n/g, '\n')
          const idx = buf.indexOf('\n\n')
          if (idx === -1) break
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)

          const em = frame.match(/^event: (.+)/m)
          const dataLines = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6))
          if (!em || dataLines.length === 0) continue

          eventType = em[1]
          try {
            const payload = JSON.parse(dataLines.join('\n'))
            events.value.push({ type: eventType, data: payload })
            eventHandlers[eventType]?.(payload)
          } catch (e) { /* ignore parse errors */ }
        }
      }
    } finally {
      isStreaming.value = false
    }
  }

  function disconnect() {
    abortController?.abort()
    isStreaming.value = false
  }

  onUnmounted(disconnect)

  return { isStreaming, events, connect, disconnect, onEvent }
}
```

### 6.3 新增 `components/sqlgen/AgentActivity.vue`

实时展示 Agent 的活动过程：

```vue
<template>
  <div class="agent-activity">
    <!-- 思考过程（可折叠） -->
    <div v-if="thinkingText" class="thinking-block">
      <div class="thinking-header" @click="showThinking = !showThinking">
        💭 思考过程
        <span class="toggle">{{ showThinking ? '收起' : '展开' }}</span>
      </div>
      <div v-if="showThinking" class="thinking-body">{{ thinkingText }}</div>
    </div>

    <!-- 工具调用列表 -->
    <div v-for="tool in toolCalls" :key="tool.id" class="tool-block">
      <div class="tool-header">🔧 {{ tool.name }}</div>
      <div class="tool-result">{{ tool.result }}</div>
    </div>

    <!-- 用户提问 Widget -->
    <div v-for="q in pendingQuestions" :key="q.id" class="question-widget">
      <SelectWidget v-if="q.method === 'select'" :question="q" @answer="onAnswer" />
      <ConfirmWidget v-if="q.method === 'confirm'" :question="q" @answer="onAnswer" />
      <InputWidget v-if="q.method === 'input'" :question="q" @answer="onAnswer" />
    </div>

    <!-- Agent 文本输出 -->
    <div v-if="agentText" class="agent-text md-content" v-html="renderedText"></div>

    <!-- 文件下载 -->
    <FileDownloadCard v-for="file in files" :key="file.url" :file="file" />
  </div>
</template>
```

Props：
- `thinkingText`：Agent 思考文本
- `toolCalls`：工具调用列表 `[{ id, name, args, result }]`
- `pendingQuestions`：待回答问题 `[{ id, method, title, options, message }]`
- `agentText`：Agent 最终文本输出
- `files`：生成的文件列表 `[{ name, url, size }]`

Events：
- `@answer(questionId, response)`：用户回答问题

### 6.4 新增 `components/sqlgen/FileDownloadCard.vue`

```vue
<template>
  <div class="file-download-card" @click="download">
    <div class="file-icon">{{ iconFor(file.name) }}</div>
    <div class="file-info">
      <div class="file-name">{{ file.name }}</div>
      <div class="file-size" v-if="file.size">{{ formatSize(file.size) }}</div>
    </div>
    <div class="download-btn">下载</div>
  </div>
</template>
```

下载逻辑：
```javascript
async function download() {
  const resp = await fetch(file.url, { headers: authHeaders() })
  const blob = await resp.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = file.name
  a.click()
  URL.revokeObjectURL(a.href)
}
```

### 6.5 修改 `views/GenerateView.vue`

#### 主要变化

```javascript
// 旧
const { connect, onMessage } = useWebSocket()

// 新
const { isStreaming, events, connect, disconnect, onEvent } = useSSE()
```

#### SSE 事件处理

```javascript
// 注册事件处理器
onEvent('agent_start', () => {
  agentActivity.value = { thinking: '', tools: [], text: '', files: [] }
})

onEvent('message_update', (p) => {
  const sub = p.assistantMessageEvent
  switch (sub.type) {
    case 'thinking_delta':
      agentActivity.value.thinking += sub.delta
      break
    case 'text_delta':
      agentActivity.value.text += sub.delta
      break
    case 'text_end':
      agentActivity.value.text = sub.content || agentActivity.value.text
      break
  }
})

onEvent('tool_execution_start', (p) => {
  agentActivity.value.tools.push({
    id: p.toolCallId, name: p.toolName, args: p.args, result: null
  })
})

onEvent('tool_execution_end', (p) => {
  const tool = agentActivity.value.tools.find(t => t.name === p.toolName)
  if (tool) tool.result = extractToolResult(p.result)
})

onEvent('user_question', (p) => {
  pendingQuestions.value.push(p)
})

onEvent('agent_end', () => {
  isStreaming.value = false
  extractFinalResult()
})
```

#### 结果提取

```javascript
function extractFinalResult() {
  // 从 Agent 文本中提取 SQL
  const text = agentActivity.value.text
  const sqlMatch = text.match(/```sql\n([\s\S]*?)\n```/)
  if (sqlMatch) {
    finalSql.value = sqlMatch[1].trim()
  }

  // 显示结果面板
  showResult.value = true
}
```

### 6.6 修改 `components/sqlgen/DecisionPanel.vue`

适配 `user_question` 格式：

```javascript
// 旧格式
// { decision_type: 'field_conflict', decision_data: [...] }

// 新格式
// { id: 'uuid', method: 'select', title: '...', options: ['...'] }

// 适配：将新格式映射到组件内部格式
function adaptQuestion(q) {
  return {
    id: q.id,
    decision_type: 'user_select',
    title: q.title,
    message: q.message,
    data: q.options?.map(opt => ({ source: opt })) || [],
  }
}

// 回答
async function onAnswer(questionId, value) {
  await request.post(`/generate/${historyId.value}/ui-response`, {
    id: questionId,
    value: value,
  })
  // 从待回答列表中移除
  pendingQuestions.value = pendingQuestions.value.filter(q => q.id !== questionId)
}
```

### 6.7 不变的组件

| 组件 | 原因 |
|------|------|
| `ResultTabs.vue` | 接受 sql/fieldMapping/verification props，输入格式不变 |
| `TableManageView.vue` | CRUD 功能，不涉及生成流程 |
| `ExampleManageView.vue` | CRUD 功能 |
| `TermManageView.vue` | CRUD 功能 |
| `UserManageView.vue` | 用户管理 |
| `HistoryListView.vue` | 历史记录（可后续增强显示 Agent 活动） |
| `stores/user.js` | 认证状态管理 |
| `stores/knowledge.js` | 知识库缓存 |
| `utils/request.js` | Axios 客户端 |
| `utils/download.js` | 下载工具 |

---

## 7. 文件下载

### 7.1 链路

```
Agent 生成文件（bash/write 工具）
  → 文件写入服务端文件系统
  → Agent 文本中包含链接：[下载 report.xlsx](/sessions/{sid}/files/report.xlsx)
  → 前端 Markdown 渲染器检测 /sessions/*/files/* 链接
  → 渲染为 FileDownloadCard 组件
  → 用户点击 → fetch 文件 → Blob → 本地下载
```

### 7.2 前端文件链接检测

在 `AgentActivity.vue` 的 Markdown 渲染中，自定义链接渲染器：

```javascript
function renderMarkdownWithFileLinks(text) {
  // 匹配 [text](/sessions/xxx/files/yyy) 模式
  const fileLinkRegex = /\[([^\]]+)\]\(\/sessions\/[^/]+\/files\/([^)]+)\)/g
  // 替换为 FileDownloadCard 组件的标记
  // ...
}
```

### 7.3 网关文件端点

需要网关提供 `GET /sessions/:id/files/*path` 端点（见 `docs/gateway-ui-design.md` Phase 1）。

---

## 8. 错误处理

| 场景 | 后端处理 | 前端处理 |
|------|----------|----------|
| 网关创建会话失败 | 返回 502，记录日志 | 显示错误提示 |
| SSE 流中断 | 捕获异常，发送 error 事件 | 显示"连接中断"，提供重试按钮 |
| Agent 超时 | 600s 后自动 abort + destroy | 显示"超时"，允许重新生成 |
| 用户取消 | abort + destroy + 更新状态 | 返回输入模式 |
| 网关不可用 | 返回 503 | 显示"服务不可用" |
| Agent 崩溃 | agent_end 含错误信息 | 显示错误详情 |

---

## 9. 配置

### 9.1 后端 `.env` 新增

```env
# Pi Gateway
GATEWAY_URL=http://localhost:3000
GATEWAY_JWT_TOKEN=your-jwt-token-here
GATEWAY_PROVIDER=deepseek
GATEWAY_MODEL=deepseek-chat
```

### 9.2 网关配置

网关需要：
- CWD 白名单包含 NaturalSQL 工作目录
- Provider 配置（DeepSeek API Key）
- JWT Secret（与 NaturalSQL 后端共享或独立）

### 9.3 Docker Compose

```yaml
services:
  gateway:
    image: pi-gateway  # 或 build from pi/pi-gateway
    environment:
      JWT_SECRET: ${GATEWAY_JWT_TOKEN}
      PI_CWD_ROOT: /workspace
    ports:
      - "3000:3000"
    depends_on:
      - backend
```

---

## 10. 迁移步骤

| 阶段 | 内容 | 影响范围 | 回退方案 |
|------|------|----------|----------|
| **Step 1** | 后端新增 `gateway/client.py` + `gateway/prompt_builder.py` | 无影响，新增文件 | 删除文件 |
| **Step 2** | 后端新增 v2 端点（与旧端点并存） | 无影响，新增路由 | 删除路由 |
| **Step 3** | 前端新增 `useSSE.js` + `AgentActivity.vue` + `FileDownloadCard.vue` | 无影响，新增文件 | 删除文件 |
| **Step 4** | 前端 feature flag 切换新旧流程 | 可随时切换 | flag 切回 |
| **Step 5** | 验证通过后删除旧代码 | 最终清理 | Git 回退 |

### Step 5 删除清单

```
backend/app/services/generate_service.py
backend/app/prompts/
backend/app/llm/
backend/app/ws/generate_ws.py
frontend/src/composables/useWebSocket.js
frontend/src/components/sqlgen/StepProgress.vue
```

保留：
```
backend/app/models/          # GenHistory, GenStepLog 模型
backend/app/routers/         # 所有 CRUD 路由
backend/app/services/        # auth_service, table_service 等
frontend/src/views/          # 所有 CRUD 视图
frontend/src/components/sqlgen/ResultTabs.vue
frontend/src/components/sqlgen/DecisionPanel.vue
```

---

## 11. 参考文件

| 文件 | 参考内容 |
|------|----------|
| `NaturalSQL/backend/app/services/generate_service.py` | 当前 7 步编排器（待删除） |
| `NaturalSQL/backend/app/routers/generate.py` | 当前生成路由（待修改） |
| `NaturalSQL/backend/app/config.py` | 配置定义（需新增网关配置） |
| `NaturalSQL/frontend/src/views/GenerateView.vue` | 主视图（需改造） |
| `NaturalSQL/frontend/src/components/sqlgen/DecisionPanel.vue` | 决策面板（需适配） |
| `NaturalSQL/frontend/src/composables/useWebSocket.js` | WebSocket（待删除，参考 SSE 实现） |
| `pi/pi-gateway/src/routes/chat.ts` | 网关 SSE 协议定义 |
| `pi/pi-gateway/src/routes/ui-response.ts` | UI 响应 API 契约 |
| `pi/pi-gateway/src/routes/sessions.ts` | 会话创建/删除 API |
| `docs/gateway-ui-design.md` | 网关前端设计方案（文件下载端点） |
