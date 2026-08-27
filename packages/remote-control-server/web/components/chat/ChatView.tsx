import type { ThreadEntry, ThreadPhase, ToolCallEntry } from '../../src/lib/types';
import { cn } from '../../src/lib/utils';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButtons,
} from '../ai-elements/conversation';
import { AssistantBubble, AssistantMark, UserBubble } from './MessageBubble';
import { PlanDisplay } from './PlanView';
import { ToolCallGroup } from './ToolCallGroup';

interface ChatViewProps {
  entries: ThreadEntry[];
  phase: ThreadPhase;
  activeAssistantId: string | null;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function ChatView({
  entries,
  phase,
  activeAssistantId,
  onPermissionRespond,
  emptyTitle = '开始对话',
  emptyDescription = '输入消息开始聊天',
}: ChatViewProps) {
  const grouped = groupToolCalls(entries);
  const showRequesting = phase === 'requesting' && activeAssistantId === null;

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {entries.length === 0 ? (
          <ConversationEmptyState description={emptyDescription} title={emptyTitle} />
        ) : (
          <>
            {grouped.map(item =>
              item.type === 'single' ? (
                <div className={cn(entrySpacing(entries, item.sourceIndex))} key={item.key}>
                  <EntryRenderer
                    activeAssistantId={activeAssistantId}
                    entry={item.entry}
                    onPermissionRespond={onPermissionRespond}
                    phase={phase}
                  />
                </div>
              ) : (
                <div className="-mt-2" key={item.key}>
                  <ToolCallGroup entries={item.entries} onPermissionRespond={onPermissionRespond} />
                </div>
              ),
            )}

            {showRequesting && (
              <div className="flex items-start gap-4" data-thread-indicator="requesting">
                <AssistantMark />
                <div className="flex items-center gap-1 pt-2">
                  <span aria-hidden="true" className="chat-typing-indicator">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <ConversationScrollButtons hasUserMessages={entries.some(entry => entry.type === 'user_message')} />
      </ConversationContent>
    </Conversation>
  );
}

function entrySpacing(entries: ThreadEntry[], index: number): string {
  const entry = entries[index];
  if (entry?.type === 'user_message') return 'pt-10 pb-3';
  if (entry?.type === 'assistant_message') {
    return entries[index + 1]?.type === 'tool_call' ? 'pt-3 pb-1' : 'pt-3 pb-8';
  }
  if (entry?.type === 'plan') return 'pt-3 pb-3';
  return 'py-2';
}

function EntryRenderer({
  entry,
  phase,
  activeAssistantId,
  onPermissionRespond,
}: {
  entry: ThreadEntry;
  phase: ThreadPhase;
  activeAssistantId: string | null;
  onPermissionRespond?: ChatViewProps['onPermissionRespond'];
}) {
  switch (entry.type) {
    case 'user_message':
      return <UserBubble entry={entry} />;
    case 'assistant_message':
      return <AssistantBubble active={entry.id === activeAssistantId} entry={entry} phase={phase} />;
    case 'tool_call':
      return <ToolCallGroup entries={[entry]} onPermissionRespond={onPermissionRespond} />;
    case 'plan':
      return <PlanDisplay entry={entry} />;
  }
}

type GroupedItem =
  | {
      type: 'single';
      key: string;
      entry: ThreadEntry;
      sourceIndex: number;
    }
  | {
      type: 'tool_group';
      key: string;
      entries: ToolCallEntry[];
    };

function entryKey(entry: ThreadEntry): string {
  return entry.type === 'tool_call' ? `tool:${entry.toolCall.id}` : `${entry.type}:${entry.id}`;
}

function groupToolCalls(entries: ThreadEntry[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let current: Array<{ entry: ToolCallEntry; sourceIndex: number }> = [];

  const flush = () => {
    if (current.length === 1) {
      const item = current[0];
      result.push({
        type: 'single',
        key: entryKey(item.entry),
        entry: item.entry,
        sourceIndex: item.sourceIndex,
      });
    } else if (current.length > 1) {
      result.push({
        type: 'tool_group',
        key: `tools:${current.map(item => item.entry.toolCall.id).join(':')}`,
        entries: current.map(item => item.entry),
      });
    }
    current = [];
  };

  entries.forEach((entry, sourceIndex) => {
    if (entry.type === 'tool_call') {
      current.push({ entry, sourceIndex });
      return;
    }
    flush();
    result.push({
      type: 'single',
      key: entryKey(entry),
      entry,
      sourceIndex,
    });
  });
  flush();
  return result;
}
