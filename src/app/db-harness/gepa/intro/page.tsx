import Link from 'next/link';
import styles from './page.module.css';

export default function GepaIntroPage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>GEPA GUIDE</p>
        <h1 className={styles.title}>GEPA 功能介绍</h1>
        <p className={styles.subtitle}>
          GEPA（Prompt + Policy 离线评估）用于在不影响线上主链路的前提下，先离线比较候选策略，再按审核结果应用到 DB Harness 运行配置。
        </p>
        <div className={styles.actions}>
          <Link href="/db-harness/gepa" className="btn btn-primary btn-sm">返回 GEPA 工作台</Link>
          <Link href="/db-harness/metrics" className="btn btn-secondary btn-sm">查看指标看板</Link>
        </div>
      </header>

      <section className={styles.card}>
        <h2>1. 你可以在 GEPA 做什么</h2>
        <ul>
          <li>创建离线评估任务：指定 Workspace、数据库、样本数与候选策略。</li>
          <li>横向比较候选：同时评估 Prompt 候选、Policy 候选、Template 候选、Pattern 候选。</li>
          <li>查看概述总结：快速得到推荐 Prompt / Policy 组合。</li>
          <li>查看样本对比：逐条看 Baseline 与 Candidate 的 score、延迟、token 差异。</li>
          <li>应用候选：把审核通过的策略写入 Workspace 运行配置。</li>
        </ul>
      </section>

      <section className={styles.card}>
        <h2>2. 页面主要区域说明</h2>
        <ul>
          <li>创建任务区：配置样本规模与候选集合，点击“运行 GEPA”生成 run。</li>
          <li>Run History：查看历史 run，支持切换详情与删除 run。</li>
          <li>概况总结：展示 balanced score、成功率、Empty Rate、token 成本等关键指标。</li>
          <li>指标对比展开区：模式抽取、候选集、样本对比、真实样本、原始报告（默认可折叠）。</li>
        </ul>
      </section>

      <section className={styles.card}>
        <h2>3. 推荐使用流程</h2>
        <ol>
          <li>先在 GEPA 中选择目标 Workspace + 数据源，确保样本来自真实会话与指标。</li>
          <li>勾选要比较的 Prompt / Policy 候选，运行离线评估。</li>
          <li>先看“概述总结”拿到推荐策略，再展开“样本对比”检查风险样本。</li>
          <li>确认收益后点击“应用候选”，把策略落到运行时配置。</li>
          <li>回到“指标看板”观察后续 success、empty、confidence、validation 标签变化。</li>
        </ol>
      </section>

      <section className={styles.card}>
        <h2>4. 指标含义（速览）</h2>
        <ul>
          <li>Balanced Score：综合分，越高代表整体效果越好。</li>
          <li>相对 Baseline：候选方案与基线的差值，正值通常表示提升。</li>
          <li>SQL Success Rate：样本中成功返回有效结果的比例。</li>
          <li>Empty Rate：返回空结果的比例，越低越好。</li>
          <li>Latency / P95：平均耗时与高分位耗时，反映稳定性。</li>
          <li>Token Cost：提示与回复 token 的综合成本。</li>
        </ul>
      </section>

      <section className={styles.card}>
        <h2>5. 常见建议</h2>
        <ul>
          <li>如果 Empty Rate 偏高：优先尝试提高 NER topK 或选择更完整的 Prompt。</li>
          <li>如果延迟过高：优先尝试 compact / minimal 压缩策略。</li>
          <li>如果候选收益不稳定：先不要应用，增加样本数并聚焦问题问句再评估。</li>
        </ul>
      </section>
    </div>
  );
}
