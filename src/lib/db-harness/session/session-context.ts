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

  return [
    {
      role: 'assistant',
      content: `更早对话摘要：\n${summaryText}`,
    },
    ...recentMessages,
  ];
}
