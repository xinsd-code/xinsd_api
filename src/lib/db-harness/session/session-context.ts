import { randomUUID } from 'node:crypto';
import { DBHarnessChatTurnRequest, DBHarnessSessionContext } from '../core/types';
import { compactText } from '../core/utils';

export function createDBHarnessSession(input: DBHarnessChatTurnRequest): DBHarnessSessionContext {
  const latestUserMessage = input.messages.filter((message) => message.role === 'user').at(-1)?.content?.trim() || '';
  if (!latestUserMessage) {
    throw new Error('请输入自然语言问题。');
  }

  return {
    turnId: randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    messages: input.messages,
    latestUserMessage,
    currentSql: (input.currentSql || '').trim(),
    currentResult: input.currentResult || null,
    recentQuestions: input.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .slice(-5),
  };
}

function compactConversationContent(role: 'user' | 'assistant', content: string, isLatest: boolean) {
  if (role === 'user') {
    return compactText(content, isLatest ? 480 : 220);
  }
  return compactText(content, isLatest ? 720 : 260);
}

function extractConstraintSummary(messages: DBHarnessSessionContext['messages']): string {
  const constraints = new Set<string>();
  messages.forEach((message) => {
    if (message.role !== 'user') return;
    const text = message.content;
    const timeRange = text.match(/(最近|近)\s*(\d+)\s*(天|周|月)/);
    if (timeRange) {
      constraints.add(`时间范围：${timeRange[0]}`);
    }
    const region = text.match(/(华东|华南|华北|华中|西南|西北|东北|北京|上海|深圳|广州|杭州|成都|重庆|苏州|南京|武汉|天津|福建|浙江|江苏|广东|山东|河南|河北|湖北|湖南|安徽|四川|陕西|云南|贵州|广西|新疆|内蒙古|宁夏|青海|甘肃|海南)[区市省]?/);
    if (region) {
      constraints.add(`地区限定：${region[0]}`);
    }
    const compare = text.match(/同比|环比|对比|比较|trend|compare/i);
    if (compare) {
      constraints.add(`分析意图：${compare[0]}`);
    }
    const limit = text.match(/(\d+)\s*条|top\s*(\d+)/i);
    if (limit) {
      constraints.add(`条数限制：${limit[0]}`);
    }
    if (/只看|仅看|排除|不看/.test(text)) {
      constraints.add(`过滤约束：${compactText(text, 60)}`);
    }
  });

  return constraints.size > 0
    ? `用户在更早对话中已经设定了以下约束：${Array.from(constraints).join('；')}。`
    : '未发现明确历史约束。';
}

export function buildCondensedSessionMessages(
  session: DBHarnessSessionContext,
  options?: {
    keepRecentMessages?: number;
    maxSummaryLength?: number;
  }
): DBHarnessSessionContext['messages'] {
  const keepRecentMessages = Math.max(2, options?.keepRecentMessages ?? 4);
  const maxSummaryLength = Math.max(300, options?.maxSummaryLength ?? 900);
  const safeMessages = session.messages.filter((message) => message.content.trim().length > 0);

  if (safeMessages.length <= keepRecentMessages) {
    return safeMessages.map((message, index) => ({
      role: message.role,
      content: compactConversationContent(message.role, message.content, index === safeMessages.length - 1),
    }));
  }

  const olderMessages = safeMessages.slice(0, -keepRecentMessages);
  const recentMessages = safeMessages.slice(-keepRecentMessages).map((message, index, list) => ({
    role: message.role,
    content: compactConversationContent(message.role, message.content, index === list.length - 1),
  }));

  const summaryLines = olderMessages.map((message) => (
    `${message.role === 'user' ? '用户' : '助手'}: ${compactConversationContent(message.role, message.content, false)}`
  ));
  const summaryText = compactText(summaryLines.join('\n'), maxSummaryLength);
  const constraintSummary = extractConstraintSummary(olderMessages);

  return [
    {
      role: 'assistant',
      content: `历史约束摘要：\n${constraintSummary}\n更早对话摘要：\n${summaryText}`,
    },
    ...recentMessages,
  ];
}
