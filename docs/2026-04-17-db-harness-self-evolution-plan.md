# 2026-04-17 DB Harness 自我进化实施计划（已落地版本）

## Summary

本计划拆成两条协同闭环：

- Workspace 级策略进化：绑定 workspace，仅作用当前 workspace
- Datasource 级语义进化：绑定 database instance，与 workspace 解耦

当前实现决策：

- workspace 升级粒度：单 Workspace
- workspace 样本来源：仅当前 Workspace
- workspace 应用范围：只应用当前 Workspace
- 语义配置生效方式：自动灰度（rollout overlay）
- 语义配置评估范围：同数据源全部 Workspace
- 语义配置可改范围：仅 alias / description / ner_flag

## Implementation Scope

- 新增 Workspace 升级资产模型与存储
- 新增 Datasource 语义升级资产模型与存储
- 运行时加载：workspace 已应用升级 + semantic overlay
- 新增 upgrade/semantic-upgrade service
- 新增 API：
  - `/api/db-harness/workspaces/:id/upgrades/*`
  - `/api/database-instances/:id/semantic-upgrades/*`

## Non-Goals

- 不做自动修改 semantic role / relation / PK-FK
- 不做自动源码改写
- 不放宽 Guardrail 边界
