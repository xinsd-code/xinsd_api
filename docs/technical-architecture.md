# API Forge — 技术架构文档

> 本文档面向开发者，重点描述**数据高级编排**与 **DB Harness 多智能体数据问答**两大核心子系统的设计与实现细节。

---

## 目录

1. [整体架构](#整体架构)
2. [数据高级编排子系统](#数据高级编排子系统)
   - [架构设计](#架构设计)
   - [编排引擎（Orchestration Engine）](#编排引擎orchestration-engine)
   - [节点类型与配置](#节点类型与配置)
   - [表达式系统](#表达式系统)
   - [AI Chat 编排助手](#ai-chat-编排助手)
   - [运行时分发](#运行时分发)
3. [DB Harness 多智能体子系统](#db-harness-多智能体子系统)
   - [整体链路](#整体链路)
   - [Workspace 上下文](#workspace-上下文)
   - [五个 Agent 详解](#五个-agent-详解)
   - [只读执行网关（Guardrail）](#只读执行网关guardrail)
   - [知识记忆系统（Knowledge Memory）](#知识记忆系统knowledge-memory)
   - [Catalog 与 Semantic 快照](#catalog-与-semantic-快照)
   - [Fallback 规则引擎](#fallback-规则引擎)
4. [NL2DATA 子系统](#nl2data-子系统)
5. [数据库基础层](#数据库基础层)
6. [语义配置体系](#语义配置体系)

---

## 整体架构

```
Browser (Next.js App Router)
       │
       ├── Page Routes (src/app/*)
       │       ├── /api-forward     → 高级编排工作台
       │       ├── /db-harness      → 多智能体问答工作台
       │       └── /nl2data         → 自然语言取数工作台
       │
       └── API Routes (src/app/api/*)
               ├── /api/forwards/*          → 转发 & 编排 CRUD
               ├── /api/db-harness/chat     → DB Harness 问答入口
               ├── /api/nl2data/*           → NL2DATA 执行接口
               └── /api/database-instances/* → 数据库实例管理

运行时分发（src/app/[...path]/route.ts）
       ├── /forward/*   → API 转发 + 编排执行
       └── /query/*     → DB API SQL 执行

核心库（src/lib/）
       ├── orchestration-engine.ts    → 数据编排函数式引擎
       ├── api-forward-runtime.ts     → 转发运行时
       ├── db-api.ts                  → DB API 执行
       ├── nl2data/executor.ts        → NL2DATA 两阶段执行器
       └── db-harness/                → 多智能体架构
```

---

## 数据高级编排子系统

### 架构设计

高级编排构建在 **API 转发**之上，通过在转发链路结尾插入编排管道实现无侵入的数据变换。

```
请求进入 /forward/<path>
       │
       ▼
  路由匹配（path-to-regexp）
       │
       ▼
  参数绑定 & 变量替换
       │
       ▼
  HTTP 转发至目标接口
       │
       ▼
  获取响应数据
       │
       ▼ ← orchestration 字段存在时走编排管道
  [Orchestration Engine]
    filter → map → compute → sort（按 order 字段排序执行）
       │
       ▼
  返回处理后的数据
```

配置持久化位置：`forwards` 表中的 `orchestration` JSON 字段（`OrchestrationConfig` 类型）。

### 编排引擎（Orchestration Engine）

文件：`src/lib/orchestration-engine.ts`

引擎采用**函数式管道**设计，每个节点是一个纯函数，接受当前数据并返回新数据：

```typescript
// 核心入口
function applyOrchestration(
  data: unknown,
  config: OrchestrationConfig,
  context?: Record<string, unknown>  // 接口入参，用于 $param 引用
): unknown {
  const sortedNodes = [...config.nodes].sort((a, b) => a.order - b.order);
  let result = data;
  for (const node of sortedNodes) {
    result = applyNode(result, node, context);
  }
  return result;
}
```

**路径解析系统**

引擎实现了完整的 JSON 路径解析，支持：

| 路径语法 | 说明 | 示例 |
|---------|------|------|
| `key` | 顶层字段 | `code` |
| `a.b.c` | 嵌套路径 | `data.user.name` |
| `a[].b` | 数组通配符（操作所有元素） | `data[].price` |
| `a[0].b` | 数组指定下标 | `items[0].id` |

`parsePath()` 将路径字符串解析为 `PathSegment[]`，`getByPath()` / `setByPath()` / `removeByPath()` 提供读写删操作，均支持通配符展开与深克隆。

**调试支持**

```typescript
function applyOrchestrationUpTo(
  data, config, nodeId, context
): { result: unknown; nodeResults: Record<string, unknown> }
```

可在任意节点中断，返回该节点前所有中间结果，供前端工作台单步调试使用。

---

### 节点类型与配置

#### `filter` — 字段筛选

```typescript
interface FilterNodeConfig {
  mode: 'include' | 'exclude';
  fields: string[];  // 路径列表，支持 data[].age 语法
}
```

**include 模式**：构建选择树（SelectionTree），递归遍历 JSON 结构，仅保留命中路径的值。

**exclude 模式**：调用 `removeByPath()` 逐条删除指定路径。

```json
// 示例：只保留 code 字段和 data 数组中的 id、name
{
  "mode": "include",
  "fields": ["code", "data[].id", "data[].name"]
}
```

#### `map` — 字段重命名

```typescript
interface MapNodeConfig {
  mappings: Array<{ from: string; to: string }>;
}
```

- **普通路径**：`getByPath` 读值，`setByPath` 写入新路径，`delete` 删除旧路径
- **数组项路径**（含 `[].`）：调用 `applyArrayItemMapping()`，逐元素操作，同时保留数组结构

**父子路径联动**：若先执行 `data → userlist` 的映射，后续针对 `userlist[].*` 的子级规则会优先从新路径读取，避免路径空间错位。

```json
// 示例：重命名数组内字段
{
  "mappings": [
    { "from": "data[].age", "to": "userAge" },
    { "from": "data[].price", "to": "amount" }
  ]
}
```

#### `compute` — 计算字段

```typescript
interface ComputeNodeConfig {
  computations: Array<{
    field: string;           // 目标路径，支持 data[].discountPrice
    expression?: string;     // 模板表达式，如 "{{amount}} * 0.9"
    sourceField?: string;    // 直接引用已有字段，如 "$param.taxRate"
  }>;
}
```

- `sourceField` 模式：直接从数据或入参中复制值
- `expression` 模式：通过 `safeEvaluate()` 处理模板表达式（见下节）

---

### 表达式系统

`safeEvaluate()` 支持两种引用语法：

**`{{field}}` — 引用数据字段**

```
"{{price}} * 0.9"      → 取 price 字段值，乘以 0.9
"{{a}} + {{b}}"        → 两字段相加
```

**`{{$param.key}}` — 引用接口入参**

```
"{{$param.taxRate}} * {{amount}}"  → 读取接口入参的 taxRate 字段
```

**执行流程**

1. 正则匹配所有 `{{...}}` 占位符
2. 逐个解析引用值（区分 `$param.` 前缀与数据字段）
3. 若表达式仅是单一 `{{ref}}`，直接返回原始值（保留数字类型）
4. 否则将数字替换为字面量，字符串加引号，交由 `Function("use strict; return (expr)")()` 计算
5. 仅允许数字、运算符、括号，拒绝任意代码注入

---

### AI Chat 编排助手

- 入口：编排工作区右上角 AI Chat 按钮
- Prompt 模板：`src/prompts/orchestration-ai-chat.md`（独立维护，后端动态读取注入上下文）

**注入的上下文**

| 变量 | 内容 |
|------|------|
| `{{currentScheme}}` | 当前编排节点 JSON |
| `{{nodeFormats}}` | 各节点参数格式说明 |
| `{{apiOutput}}` | 接口响应数据样本 |
| `{{inspectionErrors}}` | 当前体检报错列表 |

**输出格式**

AI 直接输出新的 `OrchestrationConfig` JSON，前端接收后经过同一套规范化 + 体检流程，再渲染到画布。

**"只修复体检报错"模式**：将 `inspectionErrors` 作为最高优先级约束注入 Prompt，引导 AI 最小改动修复当前 schema 的错误，不产生多余变动。

---

### 运行时分发

文件：`src/app/[...path]/route.ts`

所有 Next.js 标准路由以外的路径会命中根级动态分发器：

```
/forward/* → 调用 api-forward-runtime.ts 执行转发 + 编排
/query/*   → 调用 db-api.ts 执行 SQL 查询
```

支持自动解析：Path Params / Query String / `application/json` body / 表单参数。

---

## DB Harness 多智能体子系统

### 整体链路

文件：`src/lib/db-harness/`

```
DBMultiAgent.runChatTurn(input)
       │
       ├─ createDBHarnessSession()      → 构建本轮会话上下文
       ├─ resolveDBHarnessWorkspace()   → 加载 Workspace（DB实例 / 语义 / Catalog / 知识）
       ├─ new DBHarnessGateway()        → 初始化模型网关
       │
       ├─ runIntentAgent()    → 意图理解
       ├─ runSchemaAgent()    → NER 字段映射
       ├─ runQueryAgent()     → 查询计划 + SQL 编译
       ├─ runGuardrailAgent() → 安全校验 + 只读执行
       └─ runAnalysisAgent()  → 结果解读 + 追问建议
               │
               └─ DBHarnessTurnResponse {
                    reply, trace, artifacts, followUps, outcome
                  }
```

每个 Agent 步骤均被记录到 `trace`（`DBMultiAgentTraceStep[]`），前端实时展示各阶段状态与中间产物。

---

### Workspace 上下文

文件：`src/lib/db-harness/workspace/runtime.ts`

`resolveDBHarnessWorkspace()` 在每轮请求开始时加载并构建完整的运行时上下文：

```typescript
interface DBHarnessWorkspaceContext {
  workspaceId?: string;
  workspaceRules?: string;          // 工作区自定义规则
  databaseInstance: DatabaseInstance;
  profile: AIModelProfile;
  selectedModel: DBHarnessSelectedModelInput;
  endpoint: string;
  schema: DatabaseSchemaPayload;    // 数据库完整 schema
  metricMappings: DatabaseMetricViewMap;  // 语义配置映射
  catalog: DBHarnessCatalogSnapshot;      // 实体关系快照
  semantic: DBHarnessSemanticSnapshot;    // 语义字段快照
  knowledge: DBHarnessKnowledgeMemoryEntry[];  // 历史知识记忆
}
```

---

### 五个 Agent 详解

#### Intent Agent（意图理解）

文件：`src/lib/db-harness/multi-agent/intent-agent.ts`

**输入**：用户问句 + 近期历史问句 + Workspace 上下文摘要

**输出**：`DBHarnessIntentResult`

```typescript
interface DBHarnessPlanningHints {
  intent: string;          // query / comparison / analysis / diagnosis / visualization
  candidateTables: string[];
  dimensions: string[];    // 维度字段自然语言描述
  metrics: string[];       // 指标字段自然语言描述
  filters: string[];       // 筛选条件自然语言描述
  timeRangeDays?: number | null;
  notes: string[];
}
```

Prompt 注入：schema 概览（Top 表 + 字段）、语义摘要、历史问句、工作区规则。

**Fallback**：模型不可用时，通过 `buildFallbackPlanningHints()` 基于关键词匹配和 schema 统计生成基础规划。

---

#### Schema Agent（NER 字段映射）

文件：`src/lib/db-harness/multi-agent/schema-agent.ts`

**输入**：PlanningHints（来自 Intent Agent）+ NER 候选集

**输出**：`DBHarnessSchemaResult`

```typescript
interface DBHarnessNerPayload {
  normalizedTerms: string[];   // 规范化后的业务术语
  matchedMetrics: DBHarnessMatchedMetric[];  // 成功映射到字段的术语
  unmatchedTerms: string[];    // 未能映射的术语
  timeHints: string[];         // 时间范围提示
  intent: string;
}

interface DBHarnessMatchedMetric {
  term: string;
  table: string;
  column: string;
  metricName?: string;
  confidence: 'high' | 'medium' | 'low';
}
```

**NER 候选集构建**（`buildNerCandidateBundle()`）

1. 从语义配置中提取所有启用了 `enableForNer` 的字段
2. 按关键词相关度评分（字段名 × 2 + 指标名 × 2 + 别名 × 2 + 描述 × 1）
3. 按 hard limit（16条）截断，避免 Prompt 过长

---

#### Query Agent（查询计划生成）

文件：`src/lib/db-harness/multi-agent/query-agent.ts`

**输入**：IntentResult + SchemaResult + 当前 SQL 上下文

**输出**：`DBHarnessQueryResult`

```typescript
interface DBHarnessQueryPlan {
  intent: string;
  strategy: 'llm' | 'rule';      // 是否使用 LLM，还是 Fallback 规则
  targetTable?: string;
  summary: string;
  dimensions: DBHarnessQueryPlanDimension[];
  metrics: DBHarnessQueryPlanMetric[];  // 含聚合函数：count/sum/avg/max/min/value
  filters: DBHarnessQueryPlanFilter[];
  orderBy: DBHarnessQueryPlanOrderBy[];
  limit: number;
  compiled: DBHarnessCompiledQueryPlan;  // 编译后的参数化 SQL
}

interface DBHarnessCompiledQueryPlan {
  text: string;    // 参数化 SQL（含占位符）
  values: unknown[];  // 绑定参数值
  previewSql: string; // 可读的预览 SQL
}
```

Query Agent 接收 LLM 输出的结构化查询计划，校验字段合法性，并编译为 `compiled` 格式。

---

#### Guardrail Agent（只读执行网关）

文件：`src/lib/db-harness/multi-agent/guardrail-agent.ts`  
工具：`src/lib/db-harness/tools/guardrail-tools.ts`

这是系统的安全核心，负责在数据库实际执行前做最后一道防线。

**三重校验（`assertReadOnlyGuardrails()`）**

```typescript
// 1. 必须以只读关键字开头
if (!/^(select|with|show|desc|describe|explain)\b/i.test(sql)) {
  throw new Error('仅允许执行只读 SQL');
}

// 2. 禁止 SQL 注释（防注释注入）
if (/(--|\/\*)/.test(sql)) {
  throw new Error('SQL 不能包含注释');
}

// 3. 禁止危险关键字（双重保险）
if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(sql)) {
  throw new Error('SQL 包含危险关键字');
}
```

**敏感字段检测（`extractSensitiveColumns()`）**

```typescript
const SENSITIVE_FIELD_PATTERNS = [
  /password/i, /token/i, /secret/i,
  /email/i, /phone/i, /mobile/i,
  /身份证/, /手机号/, /id[_-]?card/i, /ssn/i,
];
```

将 SQL 与 schema 中所有字段名（以及别名、语义名）比对，命中敏感模式则阻断执行。

**Schema 合法性校验（`assertPlanResolvable()`）**

校验 QueryPlan 中的 `targetTable`、`dimensions`、`metrics`、`filters` 引用的所有表名和字段名必须存在于实际 schema 中，防止幻觉字段导致执行错误。

**安全执行（`executeReadOnlyPlan()`）**

```typescript
// 包裹子查询限制行数
const wrappedSql = `SELECT * FROM (${normalizedSql}) AS __db_harness_preview LIMIT ${previewLimit}`;

// 通过参数化查询执行（防 SQL 注入）
result = await executeParameterizedDatabaseQuery(
  workspace.databaseInstance,
  wrappedSql,
  plan.compiled.values
);
```

---

#### Analysis Agent（结果解读）

文件：`src/lib/db-harness/multi-agent/analysis-agent.ts`

**输入**：查询结果（行数 / 列 / 数据）+ 用户原始问句 + SQL

**输出**：`DBHarnessAnalysisResult`

```typescript
interface DBHarnessAnalysisResult {
  reply: string;       // 面向用户的自然语言解读
  summary: string;     // 简洁的结果摘要
  followUps: string[]; // 建议的追问方向（3条）
}
```

**空结果处理**：当查询返回 0 行时，返回结构化的智能提示（放宽时间范围 / 减少筛选条件 / 换维度追问）。

---

### 只读执行网关（Guardrail）

Guardrail 是 DB Harness 区别于普通 NL2SQL 工具的核心安全机制：

```
AI 生成的 SQL
      │
      ├─ [assertReadOnlyGuardrails] ← 只读关键字 + 危险关键字 + 注释检测
      │
      ├─ [assertPlanResolvable] ← 表名 / 字段名存在性校验
      │
      ├─ [extractSensitiveColumns] ← 敏感字段检测
      │
      └─ [executeReadOnlyPlan] ← 参数化查询 + 行数限制包裹
```

所有校验均在数据库连接执行前完成，任何一步失败都会返回对用户友好的错误信息，不会暴露底层错误细节。

---

### 知识记忆系统（Knowledge Memory）

文件：`src/lib/db-harness/memory/knowledge-memory.ts`

**工作机制**

用户对每轮对话的结果可提交反馈（`positive` / `corrective`），系统将问题-SQL 对以知识条目形式写入 SQLite：

```typescript
interface DBHarnessKnowledgeMemoryEntry {
  key: string;          // 基于问题生成的唯一 Key
  summary: string;      // 知识摘要（问题+SQL+纠错内容）
  tags: string[];       // 关键词标签
  source: 'schema' | 'feedback';
  feedbackType?: 'positive' | 'corrective';
  updatedAt?: string;
}
```

**召回机制**

每次 `resolveDBHarnessWorkspace()` 时，会加载同一数据库实例下的所有知识条目。Schema Agent 和 Query Agent 会将相关知识条目注入 Prompt，辅助提升同类问题的准确率。

---

### Catalog 与 Semantic 快照

DB Harness 运行时会基于 schema + 语义配置构建两个只读快照，作为 Agent Prompt 的核心上下文：

**CatalogSnapshot** — 数据库实体关系快照

```typescript
interface DBHarnessCatalogSnapshot {
  engine: 'mysql' | 'pgsql';
  entityCount: number;
  relationCount: number;
  entities: DBHarnessCatalogEntity[];  // 含字段类型、主键、外键关系
}
```

**SemanticSnapshot** — 语义字段快照

```typescript
interface DBHarnessSemanticSnapshot {
  entityCount: number;
  configuredFieldCount: number;    // 已手动配置语义的字段数
  inferredFieldCount: number;      // 通过规则推断语义的字段数
  glossary: string[];              // 全局术语表
  entities: DBHarnessSemanticEntity[];
}
```

每个 `SemanticEntity` 按语义角色（`metric / dimension / time / identifier / attribute`）归类字段，便于 Query Agent 快速定位维度和指标。

**Prompt 信息压缩**

因 Prompt Token 有限，Catalog / Semantic 会通过 `buildCatalogOverview()` / `buildSemanticOverview()` 动态生成聚焦摘要（`focusEntities`），仅包含与当前问句关键词最相关的实体。

---

### Fallback 规则引擎

当 LLM 模型超时或不可用时，系统不会直接返回错误，而是降级到规则引擎：

**Intent Fallback**（`buildFallbackPlanningHints()`）
- 基于正则匹配识别意图（对比 / 趋势 / 诊断 / 可视化 / 查询）
- 从问句提取时间范围（`近N天` 模式）

**NER Fallback**（`buildFallbackNerPayload()`）
- 从问句提取关键词
- 基于关键词评分在 schema + 语义配置中匹配候选指标

**SQL Fallback**（`buildFallbackSqlPayload()`）
- 基于评分选择最相关的目标表
- 自动识别聚合方式（count / sum / avg / max / min）
- 自动选择维度列、指标列、时间列
- 构建带时间范围过滤的基础 SQL

---

## NL2DATA 子系统

文件：`src/lib/nl2data/executor.ts`

NL2DATA 是 DB Harness 的轻量版本，面向快速取数场景，采用相同的两阶段链路设计但不维护 Workspace 上下文。

**两阶段执行**

| 阶段 | 职责 |
|------|------|
| NER 阶段 | 识别业务名词，映射到 schema 字段 |
| SQL 阶段 | 基于 NER 结果和 schema 摘要生成 SQL |

**与 DB Harness 的差异**

| 能力 | NL2DATA | DB Harness |
|------|---------|------------|
| Agent 数量 | 2（NER + SQL）| 5（Intent / Schema / Query / Guardrail / Analysis） |
| Workspace 管理 | 无 | 有（多 Workspace + 多 Session） |
| 知识记忆 | 无 | 有（Feedback → Knowledge）|
| Catalog 快照 | 无 | 有 |
| 结果解读 | 无（仅返回 SQL + 数据） | 有（Analysis Agent 生成自然语言回复）|
| 追问建议 | 基础 | 智能（基于结果数据动态生成）|
| 会话管理 | 历史持久化到 SQLite | 完整 Session 对象 |

---

## 数据库基础层

文件：`src/lib/db.ts`

所有元数据（接口配置、会话、知识记忆等）存储在 SQLite 中，通过 `better-sqlite3` 进行同步操作（Next.js API Routes 环境友好）。

**关键表**

| 表名 | 用途 |
|------|------|
| `forwards` | API 转发配置（含编排 JSON）|
| `db_apis` | DB API 配置 |
| `database_instances` | 数据库实例连接信息 |
| `ai_models` | AI 模型来源配置 |
| `nl2data_sessions` | NL2DATA 会话历史 |
| `db_harness_workspaces` | DB Harness Workspace |
| `db_harness_sessions` | DB Harness 会话（含完整消息列表）|
| `db_harness_knowledge` | 知识记忆条目（按 databaseInstanceId 分组）|

**数据目录配置**

```env
DATA_DIR=/var/lib/api-forge         # 数据根目录
SQLITE_DB_PATH=/path/to/custom.db   # 显式指定 SQLite 路径（可选）
```

---

## 语义配置体系

语义配置是连接数据库 schema 与 AI 理解能力的核心桥梁。

**配置层次**

```
数据库实例
  └── 表（table）
        └── 字段（column）
              ├── metricName     → 业务指标名称（如"订单金额"）
              ├── description    → 字段语义描述
              ├── aliases        → 别名列表（用于 NER 匹配）
              ├── semanticRole   → metric / dimension / time / identifier / attribute
              ├── calcMode       → 计算口径说明
              └── enableForNer   → 是否纳入 NER 候选集
```

**消费链路**

| 消费方 | 使用内容 |
|--------|---------|
| DB Harness / Intent Agent | schema 摘要、SemanticSnapshot 生成 Prompt |
| DB Harness / Schema Agent | NER 候选集（enableForNer 字段）|
| DB Harness / Query Agent | 指标-维度分类、外键关系 |
| NL2DATA | NER 候选集、schema 摘要 |
| DB API SQL 编辑器 | 字段 Hover 提示 |
| 数据库实例详情页 | 字段语义显示 |

**派生机制**

保存语义配置后，系统自动调用 `getEffectiveDatabaseMetricMappings()` 生成 `DatabaseMetricViewMap`，这是所有消费链路统一读取的规范化数据结构，避免各模块直接依赖配置原始格式。
