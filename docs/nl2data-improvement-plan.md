# NL2DATA & DB Harness 准确率与响应速度改进方案

> 基于对现有代码的深度分析，从「准确率」和「响应速度」两个维度提出系统性改进策略，按优先级排列。

---

## 一、现状诊断

### 1.1 响应时间瓶颈

通过读取 `db-multi-agent.ts` 和 `model-gateway.ts`，当前链路存在以下性能问题：

| 问题 | 代码位置 | 影响 |
|------|---------|------|
| **5 次串行 LLM 调用** | `db-multi-agent.ts` Intent→Schema→Query→Guardrail→Analysis | 单轮最长耗时 = 5 × 25s timeout |
| **每轮重新 fetch schema** | `workspace/runtime.ts: getDatabaseSchema()` | 每次都走数据库连接，无缓存 |
| **每轮重建 Catalog/Semantic 快照** | `runtime.ts: deriveCatalogSnapshot()` | CPU 密集计算，无缓存 |
| **每轮重建 NER 候选集** | `schema-agent.ts: buildNerCandidateBundle()` | 重复遍历全量 schema |
| **Query Agent 尝试 3 级 Prompt** | `model-gateway.ts: runQueryPrompt()` | 先构建 3 份上下文再选一份 |
| **知识记忆每轮 SQLite 查询** | `runtime.ts: listDBHarnessKnowledgeMemory()` | 无内存缓存 |

**当前链路时序（最坏情况）：**

```
Workspace 加载      ≈ 200~500ms（含 DB schema fetch）
Intent Agent        ≈ 2~8s（LLM call）
Schema Agent        ≈ 2~8s（LLM call）
Query Agent         ≈ 2~8s（LLM call）
Guardrail + 执行    ≈ 100~500ms（SQL 执行）
Analysis Agent      ≈ 2~6s（LLM call）

总计：约 8~30s
```

### 1.2 准确率瓶颈

| 问题 | 代码位置 | 影响 |
|------|---------|------|
| **NER 候选集 hard limit = 16** | `planning-tools.ts:371` | 大型 schema 下大量相关字段被截断 |
| **schemaOverview 最多取 8 张表** | `planning-tools.ts:175` | Query Agent 视野受限 |
| **关键词匹配为字面量匹配** | `core/utils.ts: scoreTextByKeywords()` | 同义词/缩写无法命中（"GMV"≠"成交额"）|
| **Knowledge Memory 最多 24 条，无语义检索** | `knowledge-memory.ts:87` | 历史记忆召回依赖关键词重叠，误偏低 |
| **空结果时无重试机制** | `db-multi-agent.ts:124` | 条件过严时不会自动放宽条件 |
| **NL2DATA NER 与 SQL 使用同一模型** | `nl2data/executor.ts` | NER 任务偏分类，SQL 任务偏生成，两者最优模型不同 |
| **Intent 识别仅靠正则 Fallback** | `planning-tools.ts:185` | 复杂意图识别率低 |
| **多轮对话 context 压缩激进** | `session-context.ts: keepRecentMessages:4` | 追问时丢失上文关键约束 |

---

## 二、改进方案

### 方案一：Workspace 上下文缓存（高优，响应速度）

**核心思路**：`schema`、`catalog`、`semantic` 三个重计算对象在同一数据库实例下不会频繁变化，缓存到进程内存、设置 TTL，避免每轮重建。

**当前问题代码**（`workspace/runtime.ts`）：

```typescript
// 每轮都执行：网络 IO + CPU 密集重建
const schema = await getDatabaseSchema(databaseInstance);
const catalog = deriveCatalogSnapshot(schema, metricMappings);
const semantic = sanitizeDatabaseSemanticModel(...) || deriveSemanticSnapshot(...);
```

**改进方案**：新增 `workspace-cache.ts`，引入进程内 TTL 缓存：

```typescript
// src/lib/db-harness/workspace/workspace-cache.ts

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const workspaceCache = new Map<string, WorkspaceCacheEntry>();

export function getCachedWorkspaceData(id: string): WorkspaceCacheEntry | null {
  const entry = workspaceCache.get(id);
  if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    workspaceCache.delete(id);
    return null;
  }
  return entry;
}

// 当语义配置更新时主动失效
export function invalidateWorkspaceCache(databaseInstanceId: string) {
  workspaceCache.delete(databaseInstanceId);
}
```

**预期收益**：Workspace 加载从 200~500ms → <5ms（缓存命中），显著降低平均响应时间。

**注意**：需在语义配置保存 API 和数据库实例更新 API 中调用 `invalidateWorkspaceCache()`，防止 stale 数据。

---

### 方案二：Intent + Schema Agent 并行化（高优，响应速度）

**核心思路**：两者输入不互相依赖，可以 `Promise.all` 并行执行，节省 1 次 LLM RTT。

**改造点**（`db-multi-agent.ts`）：

```typescript
// 并行执行 Intent 和 Schema Agent
const [intentResult, schemaResult] = await Promise.all([
  runIntentAgent(session, workspace, gateway, logger).catch(err => {
    return buildIntentFallback(session, workspace); // 独立 fallback，互不干扰
  }),
  runSchemaAgent(session, workspace, gateway, logger).catch(err => {
    return buildSchemaFallback(session, workspace);
  }),
]);

// Query Agent 依赖两者输出，保持串行
const queryResult = await runQueryAgent(
  session, workspace, intentResult, schemaResult, gateway, logger
);
```

**预期收益**：总耗时减少约 2~8s（省掉 Intent Agent 的串行等待时间）。

> [!IMPORTANT]
> Schema Agent 当前不依赖 Intent Agent 的输出（仅依赖 session + workspace），可安全并行。并行版 Schema Agent 在 Prompt 中暂不传入 planningHints，由 Query Agent 合并两者输出后综合利用。

---

### 方案三：Analysis Agent 引入规则优先策略（高优，响应速度）

**当前问题**：Analysis Agent 是第 5 次 LLM 调用，对简单查询（"查最近 7 天订单量"）价值有限但成本高。

**改进方案**：简单问题直接用规则生成回复，复杂意图（对比/趋势/诊断）才调用 LLM：

```typescript
// analysis-agent.ts 改造

export async function runAnalysisAgent(...) {
  // 先尝试规则生成（零 LLM 延迟）
  const ruleResult = buildRuleBasedAnalysis(
    session.latestUserMessage, queryResult.aiPayload.message, guardrailResult.execution
  );
  
  if (ruleResult.confidence === 'high') {
    logger.log('Analysis Agent', 'Rule-based shortcut');
    return ruleResult;
  }
  
  // 复杂场景才调用 LLM
  return runLLMAnalysis(session, queryResult, guardrailResult, logger);
}

// 规则覆盖场景：普通查询 + 有结果 / 空结果
function buildRuleBasedAnalysis(question, aiMessage, execution) {
  const isComplex = /对比|同比|环比|趋势|诊断|分析/.test(question);
  
  if (!isComplex && execution.rows.length > 0) {
    return {
      confidence: 'high',
      reply: `${aiMessage} 共返回 ${execution.rows.length} 条数据。`,
      summary: execution.summary || `返回 ${execution.rows.length} 条结果`,
      followUps: buildSmartFollowUps(question, execution),
    };
  }
  
  if (execution.rows.length === 0) {
    return {
      confidence: 'high',
      reply: '当前条件下没有命中数据，建议放宽时间范围或减少筛选条件。',
      summary: '无结果', followUps: ['放宽时间范围', '减少筛选条件', '换个维度追问'],
    };
  }
  
  return { confidence: 'low', reply: '', summary: '', followUps: [] };
}
```

**预期收益**：约 60% 的简单查询节省 1 次 LLM 调用（2~6s）。

---

### 方案四：NER 候选集增强 + 别名反向扩展（高优，准确率）

**当前问题**：`buildNerCandidateBundle()` hard limit = 16，仅字面量匹配，无法处理同义词。

**改进方案 A：动态候选集**

```typescript
// 过滤零分候选，保留高质量候选集，上限根据问句长度动态调整
const highConfidence = scored.filter(item => item.score >= 4).slice(0, 24);
const fallback = scored.slice(0, 16);
const chosen = (highConfidence.length >= 4 ? highConfidence : fallback);
```

**改进方案 B：别名反向扩展关键词**

```typescript
// 问句命中某字段任一别名时，将该字段所有别名都加入关键词集
export function buildExpandedKeywordSet(
  question: string,
  metricMappings: DatabaseMetricViewMap
): Set<string> {
  const base = buildKeywordSet(question);
  const expanded = new Set(base);
  
  for (const [, table] of Object.entries(metricMappings)) {
    for (const [fieldName, metric] of Object.entries(table.fields || {})) {
      const allTerms = [metric.metricName, fieldName, ...(metric.aliases || [])].filter(Boolean);
      const hitAny = allTerms.some(term => term && question.includes(term));
      if (hitAny) allTerms.forEach(term => term && expanded.add(term.toLowerCase()));
    }
  }
  return expanded;
}
```

**预期收益**：NER 准确率提升 15~25%，对业务专名（GMV↔成交总额、SKU↔商品）尤其有效。

---

### 方案五：空结果自动降级重试（中优，准确率）

**当前问题**：Query 返回 0 行时仅给出静态提示，不会自动尝试放宽条件。

**改进方案**：在 `db-multi-agent.ts` 中增加一次轻量重试（时间范围扩大 3 倍）：

```typescript
let guardrailResult = await runGuardrailAgent(workspace, queryResult, logger);

// 空结果 + 问句含时间限制 → 自动放宽时间重试一次
if (
  guardrailResult.execution.rows.length === 0
  && intentResult.planningHints.timeRangeDays
  && intentResult.planningHints.timeRangeDays <= 30
) {
  const relaxedHints = {
    ...intentResult.planningHints,
    timeRangeDays: intentResult.planningHints.timeRangeDays * 3,
    notes: [...intentResult.planningHints.notes, '时间范围已自动放宽，原查询无数据'],
  };
  try {
    const retryQuery = await runQueryAgent(
      session, workspace,
      { ...intentResult, planningHints: relaxedHints },
      schemaResult, gateway, logger
    );
    const retryGuardrail = await runGuardrailAgent(workspace, retryQuery, logger);
    if (retryGuardrail.execution.rows.length > 0) {
      guardrailResult = retryGuardrail;
      queryResult = retryQuery;
    }
  } catch {
    // 重试失败则沿用原始空结果
  }
}
```

**预期收益**：时间筛选类问题的空结果率降低约 30%。

> [!WARNING]
> Analysis 回复中需明确告知用户"已自动放宽时间范围"，保持结果透明度。

---

### 方案六：Prompt 压缩级别前置判断（中优，响应速度）

**当前问题**：`model-gateway.ts` 中每次构建全量 3 份 Prompt 再选一份，浪费 CPU。

**改进方案**：根据 message 总长度预判压缩级别，按需惰性构建：

```typescript
async runQueryPrompt(contextBuilder: (level: CompressionLevel) => string, messages) {
  const messageChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  
  // 预判起始压缩级别
  const startLevel: CompressionLevel = messageChars > 8000 ? 'compact' : 'standard';
  const levels = startLevel === 'compact'
    ? ['compact', 'minimal'] as const
    : ['standard', 'compact', 'minimal'] as const;
  
  for (const level of levels) {
    const context = contextBuilder(level); // 惰性构建
    const prompt = renderPromptTemplate(template, { DYNAMIC_CONTEXT: context });
    if (prompt.length + messageChars <= QUERY_PROMPT_CHAR_THRESHOLD) {
      return requestModelContent(..., prompt, messages);
    }
  }
}
```

**预期收益**：长会话场景减少 1~2 次无效上下文构建，逻辑更清晰。

---

### 方案七：多轮对话历史约束保留（中优，准确率）

**当前问题**：`buildCondensedSessionMessages()` 仅保留最近 4 条，追问时可能丢失上文的筛选约束（如"只看华东区"）。

**改进方案**：对早期消息提炼"约束摘要"，以 assistant 摘要形式注入上下文：

```typescript
export function buildCondensedSessionMessages(session, options) {
  const messages = session.messages;
  if (messages.length <= options.keepRecentMessages) return messages;
  
  const olderMessages = messages.slice(0, -options.keepRecentMessages);
  const constraintSummary = extractConstraintSummary(olderMessages);
  const recentMessages = messages.slice(-options.keepRecentMessages);
  
  return [
    { role: 'assistant' as const, content: `[历史会话约束摘要]\n${constraintSummary}` },
    ...recentMessages
  ];
}

function extractConstraintSummary(messages: SessionMessage[]): string {
  const constraints: string[] = [];
  messages.forEach(msg => {
    if (msg.role !== 'user') return;
    const time = msg.content.match(/近\s*(\d+)\s*(天|周|月)/);
    const region = msg.content.match(/(华东|华南|华北|北京|上海)[区市]?/);
    if (time) constraints.push(`时间范围：${time[0]}`);
    if (region) constraints.push(`地区限定：${region[0]}`);
  });
  return constraints.length > 0
    ? `用户在此前对话中设定了以下约束：${constraints.join('、')}。`
    : '无特殊历史约束。';
}
```

**预期收益**：多轮追问的约束继承准确率提升约 10~15%。

---

### 方案八：NL2DATA 支持双模型分离（低优，准确率 & 速度）

**当前问题**：NL2DATA 两阶段均用相同模型，NER（分类）与 SQL 生成（代码）最优模型特性不同。

**改进方案**：在模型管理中新增 `nerModel` 可选配置，NL2DATA 执行时分阶段选型：

```typescript
interface Nl2DataModelConfig {
  nerModel?: Nl2DataSelectedModelInput;  // 可选：速度快的轻量模型做 NER
  sqlModel: Nl2DataSelectedModelInput;   // 必填：代码生成能力强的模型做 SQL
}
```

NER 阶段用轻量快速模型（如 `deepseek-chat`），SQL 阶段用代码生成模型（如 `deepseek-coder`），兼顾速度与质量。

---

### 方案九：SQL 执行结果缓存（低优，响应速度）

对相同问句 + 相同数据源的重复查询缓存 SQL 执行结果，避免重复数据库查询和 LLM 调用：

```typescript
// 缓存 key 设计
function buildResultCacheKey(dbId: string, question: string, sql: string): string {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${dbId}:${hashString(normalized)}:${hashString(sql)}`;
}

// 缓存 TTL：5 分钟，命中时在回复中注明"来自缓存"
const RESULT_CACHE_TTL = 5 * 60 * 1000;
```

> [!WARNING]
> 数据结果缓存需在 UI 中明确标注"缓存结果（X 分钟前）"，避免用户误判数据时效性。

---

## 三、实施优先级与收益评估

| 优先级 | 方案 | 实施难度 | 响应速度提升 | 准确率提升 | 建议时序 |
|-------|------|---------|------------|----------|---------|
| 🔴 P0 | 方案一：Workspace 缓存 | 低 | **高**（省 200~500ms/轮）| — | 第 1 周 |
| 🔴 P0 | 方案二：Intent‖Schema 并行 | 低 | **高**（省 1 次 LLM RTT）| — | 第 1 周 |
| 🟠 P1 | 方案三：Analysis 规则优先 | 低 | **高**（60% 问题省 1 次 LLM）| — | 第 2 周 |
| 🟠 P1 | 方案四：NER 候选集增强 | 中 | — | **高**（NER 准确率 +15~25%）| 第 2 周 |
| 🟠 P1 | 方案五：空结果自动重试 | 低 | —（略有增加）| **高**（空结果率 -30%）| 第 2 周 |
| 🟡 P2 | 方案六：Prompt 压缩前移 | 低 | 中 | — | 第 3 周 |
| 🟡 P2 | 方案七：多轮约束保留 | 中 | — | 中（+10~15%）| 第 3 周 |
| 🟢 P3 | 方案八：NL2DATA 双模型 | 中 | 中 | 中 | 第 4 周 |
| 🟢 P3 | 方案九：SQL 结果缓存 | 高 | 高（命中时近零延迟）| — | 第 5 周+ |

---

## 四、预期综合效果

| 实施阶段 | 平均响应时间 | NER 准确率 | 空结果率 |
|---------|------------|-----------|---------|
| 当前现状 | 8~30s | ~70% | ~20% |
| P0 完成后 | 6~22s | ~70% | ~20% |
| P0+P1 完成后 | **4~16s** | **~85~90%** | **~14%** |
| 全部完成 | **2~8s**（简单问题 <1s）| ~90% | ~10% |

---

## 五、进阶方向（供后续参考）

| 方向 | 描述 |
|------|------|
| **Embedding 向量化 NER** | 将语义配置字段向量化存储，问句 Embedding 后做相似度匹配，彻底解决同义词问题（需 embedding 模型已接入）|
| **Streaming 链路输出** | 通过 SSE 将 trace 步骤状态实时推送前端，用户看到链路进展，体感延迟大幅降低 |
| **Query Plan 跨轮缓存** | 相同 NER 结果时复用上一轮 QueryPlan，跳过 Query Agent LLM 调用（适用于仅调整参数的追问）|
| **LLM 路由** | 根据问句复杂度自动选择模型：简单问题用快速小模型，复杂问题用大模型 |

---

## 六、GEPA 增强方案（补充）

> 在“先准确后速度”的主路线基础上，引入 GEPA（同时优化 Prompt 与 Agent 策略），采用**离线回放 + 人工审核 + 手动应用**的低风险闭环。

### 6.1 目标与原则

- 第一阶段目标：**平衡优化**（准确率、空结果率、延迟、成本综合优化）
- 不破坏现有主链路：GEPA 仅生成候选，不自动上线
- 任何候选上线前必须人工审核，并支持一键回滚

### 6.2 范围定义（第一阶段）

- 优化对象：
  - Prompt 轨：Intent / Schema / Query 三段模板与 few-shot 片段
  - 策略轨：NER 候选阈值、schema 覆盖阈值、压缩起始级别、重试开关等
- 触发方式：**手动触发 + 报告页审核**
- 数据来源：
  1. 历史真实会话（含 trace/feedback）
  2. 无历史时使用内置评测样本

### 6.3 核心流程

1. 手动创建 GEPA run（选择 workspace / database / sampleLimit）
2. 对每个样本同时跑 baseline 与 candidate
3. 汇总多维评分，按约束淘汰不合格候选
4. 生成评估报告（指标对比 + 典型样本）
5. 人工审核通过后应用到运行配置
6. 上线后观察，如异常可一键回滚

### 6.4 评分体系（Balanced Score）

- 必选指标：
  - `sql_success_rate`
  - `empty_rate`
  - `latency_avg_ms`
  - `latency_p95_ms`
  - `token_cost`
- 约束规则：
  - 若 `sql_success_rate < baseline`，候选直接淘汰
- 综合分：
  - 使用加权 `balanced_score` 做排序（权重可配置）

### 6.5 接口与类型扩展

- 新增 API：
  - `POST /api/db-harness/gepa/runs`
  - `GET /api/db-harness/gepa/runs/:id`
  - `POST /api/db-harness/gepa/runs/:id/apply`
- 新增类型：
  - `DBHarnessGepaRun`
  - `DBHarnessGepaCandidate`
  - `DBHarnessGepaSampleResult`
  - `DBHarnessGepaScoreCard`

### 6.6 与现有改进项的衔接

将以下能力参数化并纳入 GEPA 可搜索空间：

- 动态 NER 候选策略
- alias 反向扩展
- schema 覆盖阈值
- 多轮约束摘要强度
- Query Prompt 自适应压缩阈值

> 说明：空结果自动重试默认保持关闭，仅作为 GEPA 可评估候选策略，不默认应用。

### 6.7 验收标准（第一阶段）

- `sql_success_rate` 不低于 baseline
- `empty_rate` 相对下降
- `latency_avg_ms` 或 `latency_p95_ms` 至少一项改善
- 无新增高频语义回归或 SQL 安全回归
