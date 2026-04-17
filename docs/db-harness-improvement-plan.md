# DB Harness 全路线图重写

> 版本: v3.0 | 日期: 2026-04-16 | 状态: 已重写为可实施路线图

## 1. 概要

本路线图用于把 DB Harness 的后续演进整理成一份和当前代码库一致、可直接落地的中文方案。重点是修正过时的现状描述，保留“本地单人模式”的边界，并把后续工作按依赖关系排成清晰阶段。

当前路线图明确基于以下事实：
- DB Harness 已经有会话、访问校验与路由基础，但本阶段不扩展认证、租户隔离或资源归属模型。
- MongoDB 已经是现有支持面之一，后续阶段必须继续覆盖。
- 第一优先级是 telemetry / metrics 底座，因为 confidence、缓存、模板库和 GEPA 都依赖它。

## 2. 当前状态

### 2.1 真实架构

DB Harness 当前由 `DBMultiAgent.runChatTurn()` 串起 5 个 Agent：

```
Intent Agent → Schema Agent → Query Agent → Guardrail Agent → Analysis Agent
```

实际实现还包含一条空结果自动重试路径：如果开启 `DB_HARNESS_EMPTY_RESULT_RETRY`，且首次执行返回空结果，则会在放宽时间范围后重跑一次 Query / Guardrail，再决定是否替换最终结果。

核心代码位置：
- [`src/lib/db-harness/multi-agent/db-multi-agent.ts`](/Users/xinsd/Documents/vibe_coding/xinsd-api/src/lib/db-harness/multi-agent/db-multi-agent.ts)
- [`src/lib/db-harness/gateway/model-gateway.ts`](/Users/xinsd/Documents/vibe_coding/xinsd-api/src/lib/db-harness/gateway/model-gateway.ts)
- [`src/lib/db-harness/core/types.ts`](/Users/xinsd/Documents/vibe_coding/xinsd-api/src/lib/db-harness/core/types.ts)
- [`src/lib/db-harness/core/trace.ts`](/Users/xinsd/Documents/vibe_coding/xinsd-api/src/lib/db-harness/core/trace.ts)
- [`src/lib/db-harness/memory/knowledge-memory.ts`](/Users/xinsd/Documents/vibe_coding/xinsd-api/src/lib/db-harness/memory/knowledge-memory.ts)

### 2.2 已有能力

- 路由层已经存在 `requireSession` 与数据库实例访问校验，当前路线图不改这部分安全边界。
- Workspace cache、Knowledge Memory、GEPA、Prompt 模板和 Guardrail 已经具备基础实现。
- 引擎支持并不只限于 SQL：MongoDB 已经在 DB Harness / NL2DATA / 数据源层中被明确支持。

### 2.3 主要不足

| 类别 | 问题 | 影响 |
|------|------|------|
| 准确度 | NER 主要依赖关键词子串匹配，语义召回有限 | “销售额”不一定能联想到“营业收入” |
| 准确度 | Query 只有单候选，缺少显式 confidence | 无法判断结果可靠性 |
| 速度 | Intent 和 Schema 当前仍是串行执行 | 无谓增加总耗时 |
| 速度 | 缺少后置执行结果缓存 | 重复查询仍需完整流水线 |
| 进化 | GEPA 目前偏启发式，缺少真实评估底座 | 优化结论不够可靠 |
| 进化 | Knowledge Memory 缺少结构化纠偏与质量管理 | 低质量记忆容易堆积 |

## 3. 实施顺序

### 阶段 0：Telemetry 底座

先把“能量化”这件事做好，后续的 confidence、缓存、模板库、GEPA 才有客观依据。

要做的事：
- 扩展 gateway 返回模型元数据、token usage、上游延迟。
- 为 trace 增加 `startedAt`、`completedAt`、`durationMs`。
- 新增 metrics 采集与持久化能力，记录每轮问答的结果、耗时、模型使用、confidence、cache 命中等。

### 阶段 1：先做可见收益

这一阶段优先做能直接改善用户体验的改动。

要做的事：
- 给单候选结果加入 `confidence`。
- 把 corrective feedback 变成结构化记忆，并让 Schema Agent 优先消费纠正规则。
- 将 Intent 和 Schema 并行执行，失败时安全降级。
- 加后置执行结果缓存，按引擎感知的 query fingerprint + 数据库身份命中，并暴露 `fromCache`。

### 阶段 2：提升上下文质量

在不改变外部行为的前提下，提升语义召回和上下文质量。

要做的事：
- 用 embedding 索引增强语义 NER，保留关键词匹配作为前置层。
- 做 prompt / context 压缩优化，但不改变外部行为。
- 补充 schema 新鲜度与 memory 质量管理。

### 阶段 3：可控自我进化

等前面的数据和信号足够稳定后，再把模板库和 GEPA 做成真正可验证的闭环。

要做的事：
- 增加查询模板库，但只允许在高置信度 + 正向反馈条件下入库。
- 增加基于真实标签和真实执行结果的 GEPA online evaluator。
- 增加 pattern extractor 和性能退化触发器。

### 阶段 4：体验与后期增强

这一阶段只做不影响主流程稳定性的增强项。

要做的事：
- 支持 streaming / progress 事件。
- 增加执行结果验证与 confidence 下调逻辑。
- 增加指标看板，但只在 metrics 底座稳定后推进。

## 4. 接口变化

### 4.1 结果与 Trace

- `DBHarnessTurnResponse` / artifacts 增加 `confidence: number`。
- `DBHarnessTurnResponse` / artifacts 增加 `fromCache?: boolean`。
- `DBMultiAgentTraceStep` 增加 `startedAt?: string`。
- `DBMultiAgentTraceStep` 增加 `completedAt?: string`。
- `DBMultiAgentTraceStep` 增加 `durationMs?: number`。

### 4.2 Gateway

- gateway 返回值增加 `usage`。
- gateway 返回值增加 `latencyMs`。

### 4.3 反馈记忆

- 反馈记忆增加结构化 `correctionRule`。
- 保留现有 `summary` / `tags` 兼容，不破坏旧数据。

### 4.4 Metrics

- 定义 `QueryMetricRecord`，至少包含：
  - `turnId`
  - `databaseId` / `workspaceId`
  - `engine`
  - 问题与 query fingerprint
  - 各 Agent 耗时
  - 模型 usage
  - `confidence`
  - `fromCache`
  - `outcome`
  - 反馈标签

### 4.5 引擎兼容

- 所有 DB Harness 路径都要明确考虑 MySQL / PostgreSQL / MongoDB。
- 如果某个阶段暂时不支持 Mongo，必须写成延期项，不能默认遗漏。

## 5. 边界与约束

- 所有新能力都必须在 telemetry、embedding、模板不可用时优雅降级。
- 模板库与 GEPA 只能学习带正向标签的成功样本，不能只看“执行成功”。
- 缓存限定为进程内 TTL 缓存，不引入分布式缓存。
- Streaming 只影响传输层，不改变核心编排语义。
- 安全、鉴权、多租户扩展保持不在本阶段范围内。

## 6. 测试计划

### 6.1 单元测试

- gateway 对 usage / latency 的解析。
- trace 时间戳与耗时计算。
- confidence 计算逻辑。
- corrective feedback 规则提取。
- cache fingerprint 的引擎兼容性。
- semantic NER 的合并与排序。

### 6.2 集成测试

- MySQL、PostgreSQL、MongoDB 的端到端回合。
- Intent + Schema 并行执行的成功与部分失败场景。
- cache 命中回放与 `fromCache`。
- corrective feedback 对后续回合的影响。
- metrics 记录在 success / empty / error 三类结果下都正确落库。
- 模板库仅在满足条件时才被复用。

### 6.3 兼容性检查

- 旧 session / workspace 继续可读。
- 新增字段 / 表对旧数据安全。
- 前端在 confidence / cache 标记未到位时仍能读旧响应。

## 7. 风险与缓解

| 风险 | 缓解方式 |
|------|----------|
| 缓存误命中 | 只做后置执行结果缓存，明确标记 `fromCache` |
| 模板库错误自强化 | 入库条件限制为 confidence + 正向反馈 |
| 并行化增加上游压力 | 使用特性开关并保留 provider 级限流空间 |
| 敏感数据泄露 | 指标 / 模板 / 反馈存储前增加脱敏规则 |
| 进程内 Session 不适合生产共享部署 | 仅在未来对外部署时再扩展 |

## 8. 后续可补充工作

- Schema 新鲜度管理：外部 DDL 变更探测。
- MongoDB 完整支持：online evaluator、模板库与指标看板的 Mongo 分支补齐。
- 集成测试覆盖：把关键 DB Harness 路径纳入自动化测试。
- 未来部署安全加固：当项目从本地单人模式升级到多人环境时，再补认证、资源隔离和路由保护。

