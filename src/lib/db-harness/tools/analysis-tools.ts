import { DBHarnessAnalysisResult, DBHarnessExecutionPayload } from '../core/types';

export function buildAnalysisResult(
  question: string,
  aiMessage: string,
  execution: DBHarnessExecutionPayload
): DBHarnessAnalysisResult {
  if (execution.rows.length === 0) {
    return {
      reply: '已经完成一轮 DB-Multi-Agent 取数，但当前条件下没有命中数据。你可以放宽时间范围、减少筛选条件，或者换一个维度继续追问。',
      summary: execution.summary || '查询执行成功，但当前条件下没有返回数据。',
      followUps: [
        '把时间范围放宽到最近 30 天',
        '减少筛选条件，只看总体趋势',
        '换一个分组维度继续查询',
      ],
      detail: '结果为空，已生成收缩条件与替代追问建议。',
    };
  }

  const numericColumns = execution.columns.filter((column) =>
    execution.rows.some((row) => typeof row[column] === 'number')
  );
  const textColumns = execution.columns.filter((column) =>
    execution.rows.some((row) => typeof row[column] === 'string')
  );

  const followUps = new Set<string>();
  if (textColumns.length > 0) {
    followUps.add(`按 ${textColumns[0]} 继续分组`);
  }
  if (numericColumns.length > 0) {
    followUps.add(`对 ${numericColumns[0]} 补充汇总分析`);
  }
  if (/近\s*7\s*天|最近\s*7\s*天/.test(question) === false) {
    followUps.add('只看最近 7 天的数据');
  }
  if (followUps.size < 3) {
    followUps.add('补充同比或环比视角');
  }

  return {
    reply: `${aiMessage} 当前返回 ${execution.rows.length} 行结果。`,
    summary: execution.summary || `已返回 ${execution.rows.length} 行结果，可继续基于当前 SQL 追问。`,
    followUps: Array.from(followUps).slice(0, 3),
    detail: '已基于当前结果生成摘要与下一步追问建议。',
  };
}
