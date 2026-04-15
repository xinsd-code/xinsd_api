# API Forge — 技术文档

> 本文档面向开发者，系统描述平台的整体架构、核心模块实现细节、API 接口规范与数据模型设计。

---

## 目录

1. [整体架构](#1-整体架构)
2. [技术栈与依赖](#2-技术栈与依赖)
3. [项目结构](#3-项目结构)
4. [API 高级编排 — 技术实现](#4-api-高级编排--技术实现)
   - [编排引擎架构](#41-编排引擎架构)
   - [路径解析系统](#42-路径解析系统)
   - [节点类型与配置](#43-节点类型与配置)
   - [表达式系统](#44-表达式系统)
   - [调试支持](#45-调试支持)
   - [AI Chat 编排助手](#46-ai-chat-编排助手)
   - [运行时分发与集成](#47-运行时分发与集成)
5. [NL2DATA — 技术实现](#5-nl2data--技术实现)
   - [两阶段执行流程](#52-两阶段执行流程)
   - [Fallback 规则引擎](#53-fallback-规则引擎)
   - [与 DB Harness 的差异](#55-与-db-harness-的差异)
6. [DB Harness — 技术实现](#6-db-harness--技术实现)
   - [多智能体编排器](#61-多智能体编排器)
   - [Workspace 上下文](#62-workspace-上下文)
   - [模型网关](#63-模型网关)
   - [五个 Agent 详解](#64-五个-agent-实现)
   - [只读执行网关（Guardrail）](#guardrail-agent)
   - [知识记忆系统](#65-知识记忆系统)
   - [Catalog 与 Semantic 快照](#66-catalog-与-semantic-快照)
   - [Fallback 规则引擎](#67-fallback-规则引擎)
   - [GEPA 离线评估](#68-gepa-离线评估)
7. [语义配置体系](#7-语义配置体系)
8. [API 接口规范](#8-api-接口规范)
9. [数据模型与存储](#9-数据模型与存储)
10. [安全机制](#10-安全机制)
11. [性能优化](#11-性能优化)
12. [部署架构](#12-部署架构)
13. [扩展指南](#13-扩展指南)

---

## 1. 整体架构

### 1.1 系统架构图

```
                         Browser
                           │
                           ▼
              ┌─────────────────────────┐
              │    Next.js 16 Server    │
              │     (App Router)        │
              ├─────────┬───────────────┤
              │ Page    │ API Routes    │
              │ Routes  │ (Backend)     │
              │         │               │
              │ /       │ /api/mocks/*  │
              │ /api-   │ /api/forwards │
              │  client │ /api/db-apis  │
              │ /api-   │ /api/db-      │
              │  forward│   harness/*   │
              │ /db-api │ /api/nl2data  │
              │ /nl2data│ /api/database │
              │ /db-    │   -instances  │
              │  harness│ /api/ai-      │
              │         │   models      │
              ├─────────┴───────────────┤
              │  Dynamic Catch-All      │
              │  [...path]/route.ts     │
              │  ├─ /forward/* → 转发   │
              │  └─ /query/*  → DB API │
              └──────────┬──────────────┘
                         │
          ┌──────────────┼───────────────┐
          ▼              ▼               ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │   SQLite   │ │  External  │ │  AI Model  │
   │ (元数据库)  │ │  Database  │ │  Provider  │
   │            │ │ MySQL/PG/  │ │ OpenAI     │
   │ better-    │ │ MongoDB    │ │ Compatible │
   │ sqlite3    │ │            │ │            │
   └────────────┘ └────────────┘ └────────────┘
                         │
                         ▼
                  ┌────────────┐
                  │   Redis    │
                  │  (可选缓存) │
                  └────────────┘
```

### 1.2 请求处理流

```
HTTP Request
     │
     ├─ 匹配 Page Route (/api-forward, /db-harness, ...)
     │     → 返回 React SSR 页面
     │
     ├─ 匹配 API Route (/api/*)
     │     → 执行对应的 Route Handler
     │
     └─ 匹配 Dynamic Catch-All ([...path]/route.ts)
           │
           ├─ /forward/* → findMatchingApiForward()
           │                → executeApiForwardRuntime()
           │                → applyOrchestration() (如有编排配置)
           │
           └─ /query/*  → findMatchingDbApi()
                          → executeDbApi()
```

---

## 2. 技术栈与依赖

| 层次 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Node.js | ≥20 <21 | 需通过 `.nvmrc` 锁版本 |
| 框架 | Next.js | 16 | App Router 模式 |
| UI 框架 | React | 19 | Server Components + Client Components |
| 语言 | TypeScript | 5 | 严格类型，全栈统一 |
| 代码编辑 | Monaco Editor | — | SQL / JSON 高亮编辑 |
| 样式 | CSS Modules | — | + CSS Variables 设计系统 |
| 本地存储 | better-sqlite3 | — | 同步操作，API Routes 友好 |
| 路由匹配 | path-to-regexp | — | 动态路径参数匹配 |
| 缓存 | ioredis | — | 可选，Redis 结果缓存 |
| AI 通信 | fetch (native) | — | OpenAI Compatible API |

---

## 3. 项目结构

```
src/
├── app/                              # Next.js App Router
│   ├── [...path]/route.ts            # 运行时动态分发器
│   ├── api/                          # 后端 API Routes
│   │   ├── mocks/                    # Mock CRUD
│   │   ├── forwards/                 # 转发 & 编排 CRUD
│   │   ├── db-apis/                  # DB API CRUD
│   │   ├── db-harness/               # DB Harness 多智能体
│   │   │   ├── chat/route.ts         # 问答入口
│   │   │   ├── workspaces/           # Workspace CRUD
│   │   │   ├── sessions/             # Session CRUD
│   │   │   ├── knowledge/            # 知识反馈
│   │   │   └── gepa/                 # GEPA 评估
│   │   ├── nl2data/                  # NL2DATA 执行
│   │   ├── database-instances/       # 数据库实例管理
│   │   ├── ai-models/                # AI 模型管理
│   │   ├── proxy/                    # 跨域代理
│   │   └── health/                   # 健康检查
│   ├── api-forward/                  # 转发 & 编排页面
│   ├── db-harness/                   # DB Harness 页面
│   ├── nl2data/                      # NL2DATA 页面
│   ├── api-client/                   # API 接入页面
│   ├── db-api/                       # DB API 页面
│   ├── database-instances/           # 数据库实例页面
│   ├── model-management/             # 模型管理页面
│   ├── globals.css                   # 全局样式 + 设计系统
│   └── layout.tsx                    # 根布局
│
├── lib/                              # 核心业务逻辑层
│   ├── orchestration-engine.ts       # 编排引擎（744行）
│   ├── api-forward-runtime.ts        # 转发运行时
│   ├── db-api.ts                     # DB API 匹配与执行
│   ├── db.ts                         # SQLite 数据访问层（63K）
│   ├── types.ts                      # 全局类型定义
│   ├── ai-models.ts                  # AI 模型配置工具
│   ├── database-instances.ts         # 数据库实例工具（客户端）
│   ├── database-instances-server.ts  # 数据库实例工具（服务端）
│   ├── matcher.ts                    # 路径匹配器
│   ├── json-body.ts                  # JSON Body 解析
│   ├── redis-cache.ts                # Redis 缓存操作
│   ├── sql-format.ts                 # SQL 格式化
│   ├── sql-normalize.ts              # SQL 规范化
│   ├── nl2data/                      # NL2DATA 子系统
│   │   ├── executor.ts               # 两阶段执行器（1491行）
│   │   └── harness-types.ts          # Trace 类型
│   └── db-harness/                   # DB Harness 子系统
│       ├── index.ts                  # 统一导出
│       ├── core/
│       │   ├── types.ts              # 所有接口定义（507行）
│       │   ├── trace.ts              # Trace 构建工具
│       │   ├── errors.ts             # 错误处理
│       │   └── utils.ts              # 通用工具函数
│       ├── multi-agent/
│       │   ├── db-multi-agent.ts     # 五阶段编排器
│       │   ├── intent-agent.ts       # 意图理解
│       │   ├── schema-agent.ts       # NER 字段映射
│       │   ├── query-agent.ts        # 查询计划生成
│       │   ├── guardrail-agent.ts    # 只读执行网关
│       │   └── analysis-agent.ts     # 结果解读
│       ├── tools/
│       │   ├── planning-tools.ts     # 规划工具集（49K）
│       │   ├── guardrail-tools.ts    # 安全校验工具
│       │   ├── catalog-tools.ts      # Catalog/Semantic 快照
│       │   └── analysis-tools.ts     # 分析辅助工具
│       ├── gateway/
│       │   └── model-gateway.ts      # LLM 模型网关
│       ├── memory/
│       │   ├── knowledge-memory.ts   # 知识记忆系统
│       │   └── agent-logger.ts       # Agent 日志
│       ├── session/
│       │   └── session-context.ts    # 会话上下文
│       ├── workspace/
│       │   ├── runtime.ts            # Workspace 运行时加载
│       │   └── workspace-cache.ts    # Workspace 上下文缓存
│       └── gepa/
│           └── gepa-service.ts       # GEPA 离线评估
│
├── prompts/                          # Prompt 模板文件
│   ├── orchestration-ai-chat.md      # AI 编排助手
│   ├── nl2data-ner.md                # NL2DATA NER 阶段
│   ├── nl2data-agent.md              # NL2DATA SQL 阶段
│   ├── db-harness-intent-agent.md    # Intent Agent
│   ├── db-harness-schema-agent.md    # Schema Agent
│   ├── db-harness-query-agent.md     # Query Agent
│   └── db-api-ai-chat.md             # DB API AI Chat
│
├── components/                       # React 组件
└── hooks/                            # React Hooks
```

---

## 4. API 高级编排 — 技术实现

高级编排构建在 **API 转发** 之上，通过在转发链路结尾插入编排管道实现无侵入的数据变换。

配置持久化位置：`forwards` 表中的 `orchestration` JSON 字段（`OrchestrationConfig` 类型）。

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

### 4.1 编排引擎架构

**核心文件**：`src/lib/orchestration-engine.ts`（744 行）

采用 **函数式管道（Pipeline）** 设计，每个节点是一个纯函数，接受当前数据并返回新数据：

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

### 4.2 路径解析系统

引擎实现了完整的 JSON 路径解析。`parsePath()` 将路径字符串解析为 `PathSegment[]`，支持以下语法：

| 路径语法 | 说明 | 示例 | PathSegment |
|---------|------|------|-------------|
| `key` | 顶层字段 | `code` | `{ key: "code", index: null, wildcard: false }` |
| `a.b.c` | 嵌套路径 | `data.user.name` | 3 个普通 segment |
| `a[].b` | 数组通配符（操作所有元素） | `data[].price` | `{ key: "data", wildcard: true }` + `{ key: "price" }` |
| `a[0].b` | 数组指定下标 | `items[0].id` | `{ key: "items", index: 0, wildcard: false }` |

核心操作函数：

```typescript
getByPath(obj, path)     // 读取嵌套值，通配符展开为数组
setByPath(obj, path, v)  // 写入嵌套值，自动创建中间层
removeByPath(data, path) // 删除嵌套值
```

均支持通配符展开与深克隆。

### 4.3 节点类型与配置

#### `filter` — 字段筛选

```typescript
interface FilterNodeConfig {
  mode: 'include' | 'exclude';
  fields: string[];  // 路径列表，支持 data[].age 语法
}
```

**include 模式**：构建选择树（SelectionTree），递归遍历 JSON 结构，仅保留命中路径的值。

```typescript
// Selection Tree 算法
// 1. 将路径列表构建为树形结构
const tree = buildSelectionTree(["code", "data[].id", "data[].name"]);
// 生成：root → code(terminal) / data → __ALL__ → id(terminal) / name(terminal)

// 2. 递归遍历 JSON，仅保留命中节点的值
const result = includeBySelection(data, tree);
```

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

#### `sort` — 排序限制

```typescript
interface SortNodeConfig {
  arrayPath: string;    // 目标数组路径，如 "data"
  sortField: string;    // 排序字段
  order: 'asc' | 'desc';
  limit?: number;       // 结果数量限制
}
```

### 4.4 表达式系统

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
5. 仅允许数字、运算符、括号（`/^[\d\s+\-*/().,\"]+$/`），拒绝任意代码注入

### 4.5 调试支持

```typescript
function applyOrchestrationUpTo(
  data, config, nodeId, context
): { result: unknown; nodeResults: Record<string, unknown> }
```

可在任意节点中断，返回该节点前所有中间结果（深克隆），供前端工作台单步调试使用。

### 4.6 AI Chat 编排助手

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

### 4.7 运行时分发与集成

**分发器文件**：`src/app/[...path]/route.ts`

所有 Next.js 标准路由以外的路径会命中根级动态分发器：

```
/forward/* → 调用 api-forward-runtime.ts 执行转发 + 编排
/query/*   → 调用 db-api.ts 执行 SQL 查询
```

支持自动解析：Path Params / Query String / `application/json` body / 表单参数。

**转发运行时文件**：`src/lib/api-forward-runtime.ts`

```typescript
async function executeApiForwardRuntime(requestUrl, forwardConfig, runParams) {
  // 1. 根据 targetType 获取目标接口（mock / api-client / db-api）
  // 2. 参数绑定与变量替换
  // 3. 执行 HTTP 转发
  // 4. 如有编排配置 → applyOrchestration(responseData, config, params)
  // 5. 如有 Redis 缓存配置 → writeRedisCacheValue()
  // 6. 返回处理后数据
}
```

---

## 5. NL2DATA — 技术实现

### 5.1 核心文件

**`src/lib/nl2data/executor.ts`**（1491 行）

NL2DATA 是 DB Harness 的轻量版本，面向快速取数场景，采用相同的两阶段链路设计但不维护 Workspace 上下文。包含完整的两阶段执行器、NER 候选集构建、Fallback 规则引擎、Trace 链路追踪。

### 5.2 两阶段执行流程

```typescript
// 第一阶段：NER
async function runNerStage(question, schema, metricMappings, profile, endpoint) {
  // 1. buildKeywordSet() - 提取问句关键词
  // 2. buildNerCandidateBundle() - 构建 NER 候选集
  //    - 筛选 enableForNer 字段
  //    - 按关键词评分排序（字段名×2 + 指标名×2 + 别名×2 + 描述×1）
  //    - Hard Limit 截断（16 条）
  // 3. 构建 NER Prompt，注入候选集
  // 4. 调用 AI 模型
  // 5. sanitizeNerPayload() - 规范化输出
  // 失败时 → buildFallbackNerPayload()
}

// 第二阶段：SQL
async function runSqlStage(question, nerPayload, schema, metricMappings, profile, endpoint) {
  // 1. buildSchemaOverview() - 按关键词相关度构建聚焦 Schema 摘要
  //    - 表按评分取 Top 8
  //    - 每表字段按评分取 Top 10
  // 2. 构建 SQL Prompt，注入 NER 结果 + Schema 摘要
  // 3. 调用 AI 模型
  // 4. sanitizeAiPayload() - 提取 SQL + 规范化
  // 5. normalizeSqlForExecution() - SQL 格式规范化
  // 失败时 → buildFallbackSqlPayload()
}
```

### 5.3 Fallback 规则引擎

NL2DATA 内置了三级 Fallback 机制（当 AI 模型不可用时降级）：

#### NER Fallback

```typescript
function buildFallbackNerPayload(question, schema, metricMappings) {
  // 从问句提取关键词
  // 基于关键词评分匹配 schema 中的候选指标
  // 提取时间范围提示（正则匹配"近N天"模式）
  // 推断意图类型（对比/趋势/诊断/可视化/查询）
}
```

#### SQL Fallback

```typescript
function buildFallbackSqlPayload(question, engine, schema, metricMappings, nerPayload) {
  // 1. pickFallbackTable() - 评分选择最相关的表
  // 2. 识别聚合方式（count/sum/avg/max/min/value）
  // 3. pickBestColumn() - 自动选择维度列、指标列、时间列
  // 4. 构建带时间范围过滤的基础 SQL
  // 5. 支持 MySQL / PostgreSQL / MongoDB 三种引擎
}
```

#### MongoDB 特殊处理

```typescript
// MongoDB 使用 JSON 命令格式而非 SQL
// 支持 find / aggregate / count / distinct 操作
// 自动生成 pipeline 聚合查询
function buildFallbackSqlPayload(...) {
  if (engine === 'mongo') {
    // 构建 { collection, filter, pipeline, limit } 格式
    // 自动处理 $group / $match / $sort / $limit 阶段
  }
}
```

### 5.4 安全校验与 Trace

```typescript
function assertHarnessGuardrails(sql: string) {
  // 1. 禁止注释（-- 和 /*）
  // 2. 禁止危险关键字（insert/update/delete/drop/alter/truncate/create/grant/revoke）
}
```

NL2DATA 复用了 DB Harness 的 Trace 类型定义，提供五阶段状态追踪：

```typescript
type HarnessTraceRole = 'intent' | 'schema' | 'query' | 'guardrail' | 'analysis';

interface HarnessTraceStep {
  role: HarnessTraceRole;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  detail: string;
}
```

### 5.5 与 DB Harness 的差异

| 能力 | NL2DATA | DB Harness |
|------|---------|------------|
| Agent 数量 | 2（NER + SQL）| 5（Intent / Schema / Query / Guardrail / Analysis） |
| Workspace 管理 | 无 | 有（多 Workspace + 多 Session） |
| 知识记忆 | 无 | 有（Feedback → Knowledge）|
| Catalog 快照 | 无 | 有 |
| 结果解读 | 无（仅返回 SQL + 数据） | 有（Analysis Agent 生成自然语言回复）|
| 追问建议 | 基础 | 智能（基于结果数据动态生成）|
| 会话管理 | 历史持久化到 SQLite | 完整 Session 对象 |
| 数据源支持 | MySQL / PostgreSQL / MongoDB | MySQL / PostgreSQL |
| Fallback | 有（规则引擎降级） | 有（三级 Fallback：Intent / NER / SQL） |
| 离线评估 | 无 | 有（GEPA 系统） |

---

## 6. DB Harness — 技术实现

### 6.1 多智能体编排器

**核心文件**：`src/lib/db-harness/multi-agent/db-multi-agent.ts`

```typescript
class DBMultiAgent {
  async runChatTurn(input: DBHarnessChatTurnRequest): Promise<DBHarnessTurnResponse> {
    // 1. createDBHarnessSession(input) → 构建会话上下文
    // 2. resolveDBHarnessWorkspace(input) → 加载 Workspace（含缓存）
    // 3. new DBHarnessGateway(workspace, logger) → 初始化模型网关
    //
    // 4. runIntentAgent() → 意图理解
    // 5. runSchemaAgent() → NER 字段映射
    // 6. runQueryAgent() → 查询计划 + SQL 编译
    // 7. runGuardrailAgent() → 安全校验 + 执行
    //
    // 8. [空结果自动重试] → 放宽时间范围，重试 Query + Guardrail
    //
    // 9. runAnalysisAgent() → 结果解读
    // 10. 构建 DBHarnessTurnResponse
  }
}
```

**整体链路流程图**

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

### 6.2 Workspace 上下文

**核心文件**：`src/lib/db-harness/workspace/runtime.ts`

`resolveDBHarnessWorkspace()` 在每轮请求开始时加载并构建完整的运行时上下文：

```typescript
interface DBHarnessWorkspaceContext {
  workspaceId?: string;
  workspaceRules?: string;                      // 工作区自定义规则
  runtimeConfig?: DBHarnessRuntimeConfig;       // GEPA 可调节的运行时参数
  databaseInstance: DatabaseInstance;
  profile: AIModelProfile;
  selectedModel: DBHarnessSelectedModelInput;
  endpoint: string;
  nerProfile?: AIModelProfile;                  // 独立 NER 模型（可选）
  nerSelectedModel?: DBHarnessSelectedModelInput;
  nerEndpoint?: string;
  schema: DatabaseSchemaPayload;                // 数据库完整 schema
  metricMappings: DatabaseMetricViewMap;         // 语义配置映射
  catalog: DBHarnessCatalogSnapshot;             // 实体关系快照
  semantic: DBHarnessSemanticSnapshot;           // 语义字段快照
  knowledge: DBHarnessKnowledgeMemoryEntry[];    // 历史知识记忆
}
```

**缓存机制**（`workspace-cache.ts`）：

```typescript
// 基于 workspaceId + databaseId + 两者的 updatedAt 生成缓存 Key
// 命中缓存时跳过 schema 查询、catalog/semantic 构建
const cacheKey = buildWorkspaceCacheKey({
  workspaceId, databaseId, workspaceUpdatedAt, databaseUpdatedAt
});
```

### 6.3 模型网关

**核心文件**：`src/lib/db-harness/gateway/model-gateway.ts`

```typescript
class DBHarnessGateway {
  // 支持主模型 / NER 专用模型双通道
  private getModelContext(useNer = false) { ... }

  // Intent Agent Prompt 调度
  async runIntentPrompt(context, messages) { ... }

  // Schema Agent Prompt 调度（使用 NER 模型通道）
  async runSchemaPrompt(context, messages) { ... }

  // Query Agent Prompt 调度（自适应压缩）
  async runQueryPrompt(contextBuilder, messages) {
    // 根据 preferredCompressionLevel 和字符阈值（14000）
    // 自动选择 standard → compact → minimal 压缩级别
    for (const level of startLevels) {
      const context = contextBuilder(level);
      const candidate = renderPromptTemplate(template, { DYNAMIC_CONTEXT: context });
      if (candidate.length + messageChars <= QUERY_PROMPT_CHAR_THRESHOLD) break;
    }
  }
}
```

**Prompt 模板系统**：

- 模板文件：`src/prompts/db-harness-*.md`
- 使用 `{{DYNAMIC_CONTEXT}}` 占位符注入运行时上下文
- 模板加载后缓存到 `promptTemplateCache`（Map）
- 请求超时控制：`AbortSignal.timeout(25000)`（25 秒）

### 6.4 五个 Agent 实现

#### Intent Agent（意图理解）

**文件**：`src/lib/db-harness/multi-agent/intent-agent.ts`

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

#### Schema Agent（NER 字段映射）

**文件**：`src/lib/db-harness/multi-agent/schema-agent.ts`

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

**NER 候选集构建**（`buildNerCandidateBundle()`）：

1. 从语义配置中提取所有启用了 `enableForNer` 的字段
2. 按关键词相关度评分（字段名 × 2 + 指标名 × 2 + 别名 × 2 + 描述 × 1）
3. TopK 截断（默认 16，可通过 `runtimeConfig.nerCandidateLimit` 调节到 8-32）

**支持独立 NER 模型**：可在 Workspace 中配置专门的 NER 模型通道。

**Fallback**：`buildFallbackNerPayload()` — 基于关键词评分匹配。

#### Query Agent（查询计划生成）

**文件**：`src/lib/db-harness/multi-agent/query-agent.ts`

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

**Prompt 自适应压缩**：根据上下文长度自动降级压缩级别（standard → compact → minimal）。

**Fallback**：`buildFallbackQueryPlan()` — 规则引擎生成基础 SQL。

#### Guardrail Agent（只读执行网关）

**文件**：`src/lib/db-harness/multi-agent/guardrail-agent.ts`  
**工具**：`src/lib/db-harness/tools/guardrail-tools.ts`

这是系统的安全核心，负责在数据库实际执行前做最后一道防线。

**三重校验（`assertReadOnlyGuardrails()`）**

```typescript
// 1. 必须以只读关键字开头
if (!/^(select|with|show|desc|describe|explain)\b/i.test(sql)) {
  throw new Error('仅允许执行只读 SQL');
}

// 2. 禁止 SQL 注释（防注释注入）
if (/(--|\\/\\*)/.test(sql)) {
  throw new Error('SQL 不能包含注释');
}

// 3. 禁止危险关键字（双重保险）
if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(sql)) {
  throw new Error('SQL 包含危险关键字');
}
```

MongoDB 校验：

```typescript
// 只允许 find / aggregate / count / distinct 操作
function assertMongoReadOnlyGuardrails(query: string) { ... }
```

**敏感字段检测**

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

**完整校验链路图**

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

#### Analysis Agent（结果解读）

**文件**：`src/lib/db-harness/multi-agent/analysis-agent.ts`

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

### 6.5 知识记忆系统

**核心文件**：`src/lib/db-harness/memory/knowledge-memory.ts`

**工作机制**

用户对每轮对话的结果可提交反馈（`positive` / `corrective`），系统将问题-SQL 对以知识条目形式写入 SQLite：

```typescript
interface DBHarnessKnowledgeMemoryEntry {
  key: string;          // 基于问题生成的唯一 Key
  summary: string;      // 知识摘要（问题+SQL+纠错内容）
  tags: string[];       // 关键词标签（最多 24 个）
  source: 'schema' | 'feedback';
  feedbackType?: 'positive' | 'corrective';
  updatedAt?: string;
}

// 从 schema + NER 结果派生知识
deriveKnowledgeEntries(schema, metricMappings, nerPayload)
  → 敏感字段标记为边界知识
  → NER 匹配字段标记为映射知识

// 用户反馈创建知识
createFeedbackKnowledgeEntry({ question, feedbackType, note, artifact })
  → 提取关键词 + 目标表 + 指标/维度标签
  → 生成可召回的知识条目

// 知识召回（按关键词评分排序）
buildKnowledgeOverview(entries, keywords, limit=8)
  → corrective +4 / positive +2 权重加成
  → 按评分 + 时间降序截取
```

**召回机制**

每次 `resolveDBHarnessWorkspace()` 时，加载同一数据库实例下的所有知识条目（最多 24 条）。Schema Agent 和 Query Agent 会将相关知识条目注入 Prompt，辅助提升同类问题的准确率。

### 6.6 Catalog 与 Semantic 快照

**核心文件**：`src/lib/db-harness/tools/catalog-tools.ts`

DB Harness 运行时基于 schema + 语义配置构建两个只读快照，作为 Agent Prompt 的核心上下文：

**CatalogSnapshot — 数据库实体关系快照**

```typescript
interface DBHarnessCatalogSnapshot {
  engine: 'mysql' | 'pgsql';
  entityCount: number;
  relationCount: number;
  entities: DBHarnessCatalogEntity[];  // 含字段类型、主键、外键关系
}
```

**SemanticSnapshot — 语义字段快照**

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

### 6.7 Fallback 规则引擎

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

### 6.8 GEPA 离线评估

**核心文件**：`src/lib/db-harness/gepa/gepa-service.ts`（624 行）

**评估流程**：

```
runGepaCreate(input)
  │
  ├─ 加载 Workspace + 数据源 + Schema
  ├─ extractSamples() → 从历史会话提取样本
  │   └─ 不足时 buildSyntheticSamples() → 合成样本
  │
  ├─ buildPolicyCandidates() → 生成候选策略集
  │   ├─ Prompt 候选：balanced / compact / minimal
  │   └─ Policy 候选：NER 扩容 / 平衡 / 收敛
  │
  ├─ estimatePromptScore() → 离线回放评分
  │   ├─ 构建 Fallback NER + Planning
  │   ├─ 基线 vs 候选策略评分
  │   └─ 综合分 = 成功率基分 + NER 匹配加成 - 延迟惩罚 - Token 惩罚
  │
  ├─ buildScoreCard() → 生成评分卡
  │   ├─ sqlSuccessRate / emptyRate
  │   ├─ latencyAvgMs / latencyP95Ms
  │   ├─ tokenCost / balancedScore
  │   └─ baselineBalancedScore（对比基线）
  │
  └─ 存储评估 Run（status: reviewed）

applyGepaRun(id, input)
  │
  ├─ selectApplicableCandidates() → 提取最优 Prompt + Policy 候选
  ├─ buildAppliedRuntimeConfig() → 构建运行时配置
  │   ├─ preferredCompressionLevel
  │   ├─ nerCandidateLimit
  │   ├─ schemaOverviewTables
  │   └─ promptStrategy
  ├─ updateDBHarnessWorkspace() → 写入 Workspace
  └─ 更新 Run（status: applied）
```

---

## 7. 语义配置体系

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

**数据流**

```
语义配置保存
  │
  └─ getEffectiveDatabaseMetricMappings()
       → DatabaseMetricViewMap（规范化映射）
       │
       ├─ DB Harness → deriveCatalogSnapshot() → CatalogSnapshot
       │             → deriveSemanticSnapshot() → SemanticSnapshot
       │
       ├─ NL2DATA → buildNerCandidateBundle() → NER 候选集
       │          → buildSchemaOverview() → Schema 摘要
       │
       └─ DB API → SQL 编辑器字段提示
```

---

## 8. API 接口规范

### 8.1 DB Harness 问答

```
POST /api/db-harness/chat

Request Body:
{
  "workspaceId": "ws_xxx",
  "messages": [
    { "role": "user", "content": "近7天各渠道的 GMV" }
  ],
  "selectedModel": {
    "profileId": "profile_xxx",
    "modelId": "deepseek-chat"
  },
  "nerSelectedModel": null,           // 可选：独立 NER 模型
  "databaseInstanceId": "db_xxx",
  "currentSql": "",                   // 可选：当前 SQL 上下文
  "currentResult": null               // 可选：当前结果上下文
}

Response Body:
{
  "outcome": "success" | "empty" | "error",
  "reply": "近7天各渠道 GMV 如下...",
  "trace": [
    { "role": "intent", "title": "意图理解", "status": "completed", "detail": "...", "handoff": {...} },
    { "role": "schema", "title": "字段映射", "status": "completed", ... },
    { "role": "query", "title": "查询规划", "status": "completed", ... },
    { "role": "guardrail", "title": "安全执行", "status": "completed", ... },
    { "role": "analysis", "title": "结果解读", "status": "completed", ... }
  ],
  "artifacts": {
    "sql": "SELECT ...",
    "summary": "共返回 5 行结果",
    "columns": ["channel", "gmv"],
    "previewRows": [...],
    "previewSql": "SELECT ...",
    "queryPlan": { ... },
    "catalogOverview": { ... },
    "semanticOverview": { ... }
  },
  "followUps": ["按日期维度继续分组", "对 GMV 补充环比分析", "只看最近3天"]
}
```

### 8.2 NL2DATA 执行

```
POST /api/nl2data/execute

Request Body:
{
  "messages": [
    { "role": "user", "content": "查看近7天各渠道订单金额" }
  ],
  "selectedModel": {
    "profileId": "profile_xxx",
    "modelId": "deepseek-chat"
  },
  "databaseInstanceId": "db_xxx"
}

Response Body:
{
  "outcome": "success",
  "reply": "...",
  "trace": [...],
  "artifacts": {
    "sql": "SELECT ...",
    "summary": "...",
    "columns": [...],
    "previewRows": [...]
  },
  "followUps": [...]
}
```

### 8.3 知识反馈

```
POST /api/db-harness/knowledge/feedback

Request Body:
{
  "workspaceId": "ws_xxx",
  "messageId": "msg_xxx",
  "databaseInstanceId": "db_xxx",
  "question": "用户原始问题",
  "reply": "AI 的回答",
  "feedbackType": "positive" | "corrective",
  "note": "可选的纠错说明",
  "artifacts": { ... }
}
```

### 8.4 运行时接口

```bash
# API 转发（含编排处理）
GET/POST http://localhost:3000/forward/<path>?param=value

# DB API（SQL 执行）
GET/POST http://localhost:3000/query/<path>?param=value

# 健康检查
GET http://localhost:3000/api/health
```

---

## 9. 数据模型与存储

### 9.1 存储层

**文件**：`src/lib/db.ts`

所有元数据（接口配置、会话、知识记忆等）存储在 SQLite 中，通过 `better-sqlite3` 进行同步操作（Next.js API Routes 环境友好）。

### 9.2 SQLite 关键表

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `mocks` | Mock 接口配置 | method, path, responseBody, responseStatus |
| `api_clients` | API Client 配置 | method, url, requestHeaders, requestBody |
| `forwards` | API 转发配置 | method, path, targetType, targetId, orchestration(JSON) |
| `db_apis` | DB API 配置 | path, sql, databaseInstanceId, redisConfig |
| `database_instances` | 数据库实例 | type, host, port, metricMappings(JSON), semanticModel(JSON) |
| `ai_models` | AI 模型来源 | baseUrl, authType, modelIds(JSON) |
| `nl2data_sessions` | NL2DATA 会话 | question, sql, prompt, databaseInstanceId |
| `db_harness_workspaces` | Workspace | name, databaseId, rules, runtimeConfig(JSON) |
| `db_harness_sessions` | 会话 | workspaceId, messages(JSON), selectedDatabaseId |
| `db_harness_knowledge` | 知识记忆 | key, summary, tags(JSON), feedbackType, databaseInstanceId |
| `db_harness_gepa_runs` | GEPA 评估 | workspaceId, candidateSet(JSON), scoreCard(JSON), status |
| `groups` | 接口分组 | name, variables(JSON) |

### 9.3 数据目录配置

```env
DATA_DIR=/var/lib/api-forge         # 数据根目录
SQLITE_DB_PATH=/path/to/custom.db   # 显式指定 SQLite 路径（可选）
```

---

## 10. 安全机制

### 10.1 SQL 注入防护

| 层次 | 机制 |
|------|------|
| 参数化查询 | 所有 SQL 执行使用 `executeParameterizedDatabaseQuery()`，通过占位符绑定参数 |
| 子查询包裹 | 外层 `SELECT * FROM (...) LIMIT N` 限制返回行数 |
| 只读校验 | 正则检查 SQL 必须以只读关键字开头 |
| 危险关键字 | 正则阻断 INSERT/UPDATE/DELETE/DROP/ALTER 等 |
| 注释阻断 | 阻断 `--` 和 `/* */` 注释（防注释注入） |

### 10.2 敏感数据保护

| 机制 | 说明 |
|------|------|
| 敏感字段检测 | 正则匹配 password/token/email/phone/身份证 等字段名 |
| 知识记忆标记 | 敏感字段自动标记为"边界知识"，提示 AI 回避 |
| Schema 合法性 | 查询计划中的所有表名/字段名必须在实际 schema 中存在 |

### 10.3 表达式引擎安全

编排引擎的 `safeEvaluate()` 使用严格的白名单校验：

```typescript
// 仅允许数字、运算符、括号
if (/^[\d\s+\-*/().,\"]+$/.test(processedExpr)) {
  return Function(`"use strict"; return (${processedExpr})`)();
}
```

---

## 11. 性能优化

### 11.1 Workspace 上下文缓存

基于 `workspaceId + databaseId + updatedAt` 构建缓存 Key，命中时跳过 schema 查询和 catalog/semantic 构建，减少每轮对话 100-500ms 的初始化开销。

### 11.2 Prompt 模板缓存

首次读取后缓存到内存 Map，避免重复磁盘 IO。

### 11.3 Prompt 自适应压缩

Query Agent 根据上下文长度自动降级压缩级别（`QUERY_PROMPT_CHAR_THRESHOLD = 14000`），在 standard → compact → minimal 间自动选择，减少 Token 消耗和模型延迟。

### 11.4 NER 候选集截断

Hard Limit 16 条（可调节到 8-32），按关键词评分排序后截取，确保高相关字段优先，避免 Prompt 过长导致的精度下降和延迟增加。

### 11.5 Schema 摘要聚焦

表按评分取 Top 8（可调节到 2-12），每表字段按评分取 Top 10。关键词匹配度越高、语义配置越完善的实体排名越高。

---

## 12. 部署架构

### 12.1 单机部署

```bash
# 构建
npm run build

# 启动
npm start
# 或
pm2 start ecosystem.config.js --only xinsd-api
```

### 12.2 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | `development` | 运行环境 |
| `PORT` | `3000` | 服务端口 |
| `HOSTNAME` | `localhost` | 监听地址 |
| `DATA_DIR` | `./data` | 数据根目录 |
| `SQLITE_DB_PATH` | `<DATA_DIR>/mock-data.db` | SQLite 路径 |
| `REDIS_URL` | — | Redis 连接地址（可选） |
| `DB_HARNESS_EMPTY_RESULT_RETRY` | — | 空结果自动重试开关 |

### 12.3 健康检查

```bash
curl http://localhost:3000/api/health
```

---

## 13. 扩展指南

### 13.1 新增编排节点类型

1. 在 `src/lib/types.ts` 中添加新节点配置类型
2. 在 `src/lib/orchestration-engine.ts` 中：
   - 新增 `apply<NodeType>()` 函数
   - 在 `applyNode()` 的 switch 中添加分支
3. 更新 `src/prompts/orchestration-ai-chat.md` 的节点格式说明
4. 前端添加对应的节点配置 UI

### 13.2 新增 DB Harness Agent

1. 在 `src/lib/db-harness/multi-agent/` 下创建新 Agent 文件
2. 定义 Agent 输入/输出类型（`src/lib/db-harness/core/types.ts`）
3. 在 `db-multi-agent.ts` 的 `runChatTurn()` 中插入调用
4. 新增 Prompt 模板（`src/prompts/db-harness-<agent>.md`）
5. 在 Gateway 中添加 Prompt 调度方法
6. 更新 Trace 定义，新增角色

### 13.3 新增数据库类型支持

1. 在 `src/lib/database-instances-server.ts` 中添加连接驱动
2. 仿照 MySQL/PG 实现 `getDatabaseSchema()` 和 `executeParameterizedDatabaseQuery()`
3. 在 Guardrail 中添加对应的只读校验规则
4. 在 Fallback 规则引擎中添加 SQL 方言生成

### 13.4 Prompt 模板编辑

所有 Prompt 模板位于 `src/prompts/` 目录，使用 Markdown 格式：

- `{{DYNAMIC_CONTEXT}}` — 必需的动态上下文占位符
- 修改模板后需重启服务（模板首次加载后会被缓存）
- 生产环境修改后需重新部署
