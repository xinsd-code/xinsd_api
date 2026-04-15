# API Forge

> 面向研发与数据团队的全栈 API 研发辅助平台，集 Mock 管理、接口转发、数据编排、自然语言取数与多智能体 DB 问答于一体。

![Next.js](https://img.shields.io/badge/Next.js-16-black) ![React](https://img.shields.io/badge/React-19-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6) ![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57)

---

## 模块概览

| 模块 | 功能定位 |
|------|---------|
| **Mock 接口工作台** | 快速创建本地联调接口，支持 RESTful 动态路径、流式响应、JSON Body 匹配 |
| **API 接入 (Client)** | 类 Postman 接口调试工具，内置代理解决跨域，支持 JSON Body 表单化编辑 |
| **API 转发 & 高级编排** | 虚拟接口层 + 数据处理流水线，支持筛选 / 映射 / 计算 / 排序节点串联，AI Chat 驱动编排生成 |
| **DB API** | 将只读 SQL 封装为标准化接口，支持变量绑定与 Redis 缓存 |
| **NL2DATA** | 两阶段 NER + SQL 自然语言取数工作台，会话历史持久化，支持 MySQL / PostgreSQL / MongoDB |
| **DB Harness** | 五阶段多智能体 NL2SQL 问答链路，含只读执行网关、知识记忆与 GEPA 离线评估 |
| **数据库实例管理** | 统一管理 MySQL / PostgreSQL / Redis / MongoDB 实例，含语义配置、结构浏览与语义自动生成 |
| **模型管理** | 管理 OpenAI Compatible 模型来源，支持 Chat / Embedding 两类 |

---

## 三大核心能力

### 1. 🔀 数据高级编排（Advanced Orchestration）

在 **API 转发**基础上，内置可视化工作流编辑器，将接口响应数据通过有序节点链路实时处理后再返回。

**四类处理节点**

| 节点类型 | 功能 | 典型用途 |
|---------|------|---------|
| `filter` | 字段筛选（include / exclude） | 裁剪不必要字段，精简响应体 |
| `map` | 字段重命名 / 路径映射 | 统一前后端字段命名规范 |
| `compute` | 模板表达式计算新增字段 | 生成折扣价、汇总指标等派生字段 |
| `sort` | 数组排序 + 结果限制 | 按指标取 TopN，控制返回数量 |

**核心特性**

- **嵌套路径支持**：使用 `data[].age` 语法直接操作对象数组内的属性
- **表达式引擎**：`{{field}}` 引用数据字段，`{{$param.key}}` 引用接口入参，支持四则运算
- **父子联动**：`map` 节点重命名父路径后，后续子路径规则自动跟随新命名空间
- **AI Chat 驱动**：通过自然语言直接生成或修改整条编排链路；支持"专项修复体检报错"模式
- **单节点调试**：可对任意节点单独调试，实时查看中间输出状态
- **配置持久化**：保存后自动写入 `orchestration` 字段，运行时直接走 `/forward/...` 访问

**编排节点 JSON 示例**

```json
{
  "nodes": [
    {
      "id": "filter_1", "type": "filter", "order": 0,
      "config": { "mode": "include", "fields": ["code", "data[].id", "data[].name", "data[].price"] }
    },
    {
      "id": "map_1", "type": "map", "order": 1,
      "config": { "mappings": [{ "from": "data[].price", "to": "amount" }] }
    },
    {
      "id": "compute_1", "type": "compute", "order": 2,
      "config": { "computations": [{ "field": "data[].discountPrice", "expression": "{{amount}} * 0.9" }] }
    },
    {
      "id": "sort_1", "type": "sort", "order": 3,
      "config": { "arrayPath": "data", "sortField": "discountPrice", "order": "desc", "limit": 10 }
    }
  ]
}
```

---

### 2. 🗣 NL2DATA — 自然语言取数工作台

通过自然语言问句快速生成分析 SQL，并在同一页面完成执行、查看与历史管理。

**两阶段链路**

```
用户问句
  │
  ▼
[第一阶段：NER 名词识别]
  • 从语义配置中召回 NER 候选语料（去重 + 压缩 + TopN 限额）
  • AI 识别业务名词并映射到 table.column
  • 输出：matchedMetrics / normalizedTerms / timeHints
  │
  ▼
[第二阶段：SQL 生成]
  • 将 NER 结果注入 SQL Prompt 上下文
  • AI 生成参数化查询 SQL
  • 通过只读校验后执行（拒绝写操作 + 敏感字段阻断）
  │
  ▼
结果表格 + 会话历史持久化
```

**工作台功能**

- 并列布局：当前 SQL 编辑区 / 会话历史面板 / 数据结果表格
- 会话记录持久化到 SQLite，包含：用户问句 / SQL / 完整 Prompt
- 点击历史记录可查看完整上下文，并一键"同步 SQL"回填到编辑区
- 重新执行已有 SQL 不会产生重复历史条目
- MongoDB 以 JSON 命令方式执行，只读查询会自动归一化为可执行命令

---

### 3. 🤖 DB Harness — 多智能体数据问答

面向数据分析场景的多智能体对话系统，自动完成从自然语言理解到 SQL 生成、安全执行、结果解读的完整链路。

**五阶段 Agent 链路**

```
用户提问
  │
  ▼
[Intent Agent] — 理解意图，提取规划提示（维度 / 指标 / 筛选条件 / 时间范围）
  │
  ▼
[Schema Agent] — NER 名词识别，将业务术语映射到 table.column 字段
  │
  ▼
[Query Agent] — 生成结构化查询计划（QueryPlan），编译为参数化 SQL
  │
  ▼
[Guardrail Agent] — 只读安全网关（禁止写操作 / 注释 / 敏感字段），执行查询
  │
  ▼
[Analysis Agent] — 解读查询结果，生成自然语言回复与追问建议
```

**工作空间与会话管理**

- 支持多 Workspace：每个 Workspace 绑定独立的数据源 + 工作规则
- 每个 Workspace 下可维护多条独立会话（Session）
- 每轮对话完整记录 trace 链路，可展开查看各 Agent 的中间产物，右侧链路详情会跟随最新问句自动展开
- 支持 MySQL / PostgreSQL / MongoDB 数据源，Mongo 查询走只读 JSON 命令链路

**知识记忆系统**

- 用户对回答点赞（positive feedback）或纠错（corrective feedback）后，记忆写入 SQLite
- 后续相关问题优先召回历史知识，辅助 Schema / Query Agent 提升准确率

**安全保障**

- Guardrail Agent 强制执行只读校验：只允许 `SELECT / WITH / SHOW / DESC / EXPLAIN`
- 规则引擎作为 LLM Fallback，在模型不可用时仍可基于 schema 生成基础 SQL
- Mongo 规则回退会自动避免祖先 / 子路径冲突字段，减少 `_id.buffer` 这类嵌套字段碰撞

---

## 其他功能模块

### DB API（SQL 接口化）
- 将常用只读 SQL 封装为可复用的标准接口（`/query/...`）
- 支持 `{{variable}}` SQL 变量占位符，自动识别并提供入参绑定面板
- 支持 Redis 结果缓存，缓存 Key 规则支持 `{{param}}` / JSONPath 动态拼接

### API 转发（Forwarding）
- 建立"虚拟路径"并映射至 Mock 或真实接口
- 参数绑定支持"接口入参绑定" / "固定静态值"两种模式
- 目标为 `POST application/json` 时，可直接将入参写入目标请求体字段
- Redis 结果缓存支持，默认关闭，按需开启

### 语义配置（Semantic Config）
- 图形化逐字段编辑：语义名称、描述、别名、语义角色（指标 / 维度 / 时间 / 标识符）、计算口径、NER 开关
- 保存后自动派生各消费链路（DB Harness / NL2DATA / DB API / SQL 编辑器）所需的字段映射
- 支持按库表结构与样本数据调用模型自动生成语义草稿，再人工微调保存

### GEPA 离线评估
- 对 DB Harness 的 Prompt / Policy 策略做离线回放评估
- 支持手动创建 run、查看候选对比、人工审核并应用到运行时配置
- 默认不自动切流，保留回滚与 run history 删除

---

## 快速开始

### 环境要求
- Node.js `>=20 <21`

### 安装 & 启动

```bash
npm install
npm run dev
# 访问 http://localhost:3000
```

### AI 模型配置

```bash
cp .env.example .env.local
```

启动后进入**模型管理**页，填写：
- 模型名称 + `Base URL`（兼容 OpenAI Chat Completions）
- 鉴权方式：Bearer Token / 自定义 Header
- 至少一个 `Model ID`（添加时实时校验可用性）

DeepSeek 示例：
```
Base URL: https://api.deepseek.com
Model ID: deepseek-chat
```

### 生产部署

```bash
npm run build
npm start
```

**环境变量（`.env.production`）**

```env
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
DATA_DIR=/var/lib/api-forge
```

**PM2 托管**

```bash
pm2 start ecosystem.config.js --only xinsd-api
```

**健康检查**

```bash
curl http://localhost:3000/api/health
```

> 详细部署步骤参见 [`docs/deploy-production.md`](docs/deploy-production.md)

---

## 访问路径速查

### 页面入口

| 页面 | 路径 |
|------|------|
| Mock 工作台 | `http://localhost:3000/` |
| API 接入 | `http://localhost:3000/api-client` |
| API 转发 & 编排 | `http://localhost:3000/api-forward` |
| DB API | `http://localhost:3000/db-api` |
| NL2DATA | `http://localhost:3000/nl2data` |
| DB Harness | `http://localhost:3000/db-harness` |
| 模型管理 | `http://localhost:3000/model-management` |
| 数据库实例 | `http://localhost:3000/database-instances` |

### 运行时接口

```bash
# API 转发（含编排）
curl "http://localhost:3000/forward/<path>?param=value"

# DB API
curl "http://localhost:3000/query/<path>?param=value"
```

---

## 项目结构

```
src/
├── app/
│   ├── api/               # 后端 API Routes
│   │   ├── db-harness/    # DB Harness 多智能体接口
│   │   ├── forwards/      # API 转发 CRUD
│   │   ├── db-apis/       # DB API CRUD
│   │   └── nl2data/       # NL2DATA 执行接口
│   ├── api-forward/       # 转发 & 编排页面
│   ├── db-harness/        # DB Harness 问答页面
│   └── nl2data/           # NL2DATA 工作台页面
├── lib/
│   ├── orchestration-engine.ts      # 编排引擎（filter/map/compute/sort）
│   ├── api-forward-runtime.ts       # 转发运行时执行器
│   ├── db-api.ts                    # DB API 匹配与 SQL 编译
│   ├── nl2data/
│   │   └── executor.ts              # NL2DATA 两阶段 NER + SQL 执行器
│   └── db-harness/
│       ├── core/types.ts            # 核心类型定义
│       ├── multi-agent/             # 五阶段 Agent（Intent/Schema/Query/Guardrail/Analysis）
│       ├── tools/                   # 规划工具 / Guardrail 工具 / Catalog 工具
│       ├── gateway/                 # 模型网关（统一 LLM 调用）
│       ├── memory/                  # 知识记忆系统
│       └── workspace/               # Workspace 运行时上下文
└── prompts/
    └── orchestration-ai-chat.md     # AI 编排助手 Prompt 模板
```

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 前端框架 | Next.js 16 (App Router) + React 19 |
| 语言 | TypeScript |
| 代码编辑器 | Monaco Editor |
| 样式 | CSS Modules + Modern CSS Variables |
| 后端接口 | Next.js API Routes |
| 数据库 | SQLite（better-sqlite3） |
| 路由匹配 | path-to-regexp |
| 缓存 | Redis（ioredis，可选） |

---

## 许可证

MIT License
