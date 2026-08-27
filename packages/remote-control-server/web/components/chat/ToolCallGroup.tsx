import { useId, useState } from 'react';
import type { ToolCallContent, ToolCallDiffContent, ToolCallTerminalContent } from '../../src/acp/types';
import type { ToolCallData, ToolCallEntry } from '../../src/lib/types';
import { toRenderableContentBlock } from '../../src/lib/thread-state';
import { cn } from '../../src/lib/utils';
import { ToolPermissionButtons } from '../ai-elements/permission-request';
import { ContentBlockView } from './ContentBlockView';

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
  defaultExpanded?: boolean;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}

export function ToolCallGroup({ entries, defaultExpanded = false, onPermissionRespond }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();
  if (entries.length === 0) return null;

  if (entries.length === 1) {
    return (
      <div className="pl-10">
        <SingleToolCard
          compact
          defaultExpanded={defaultExpanded}
          onPermissionRespond={onPermissionRespond}
          tool={entries[0].toolCall}
        />
      </div>
    );
  }

  return (
    <div className="pl-10">
      <div className="overflow-hidden rounded-lg border border-border bg-surface-2/50">
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-1/50"
          onClick={() => setExpanded(value => !value)}
          type="button"
        >
          <svg
            aria-hidden="true"
            className={cn('text-text-muted transition-transform', expanded && 'rotate-90')}
            fill="none"
            height="12"
            viewBox="0 0 12 12"
            width="12"
          >
            <path d="M4 2L8 6L4 10" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span className="text-xs text-text-muted">{buildSummary(entries)}</span>
        </button>
        <div className="divide-y divide-border border-t border-border" hidden={!expanded} id={panelId}>
          {entries.map(entry => (
            <SingleToolCard
              compact
              defaultExpanded
              key={entry.toolCall.id}
              onPermissionRespond={onPermissionRespond}
              tool={entry.toolCall}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface SingleToolCardProps {
  tool: ToolCallData;
  compact?: boolean;
  defaultExpanded?: boolean;
  onPermissionRespond?: ToolCallGroupProps['onPermissionRespond'];
}

const terminalStatuses = new Set<ToolCallData['status']>(['completed', 'rejected', 'error', 'cancelled']);

function statusMark(status: ToolCallData['status']) {
  switch (status) {
    case 'queued':
      return (
        <span aria-hidden="true" className="text-[10px] text-text-muted">
          &#9675;
        </span>
      );
    case 'in_progress':
      return (
        <span aria-hidden="true" className="text-[10px] text-status-running">
          &#9654;
        </span>
      );
    case 'waiting_for_confirmation':
      return (
        <span aria-hidden="true" className="text-[10px] text-brand">
          &#9083;
        </span>
      );
    case 'completed':
      return (
        <span aria-hidden="true" className="text-[10px] text-status-active">
          &#10003;
        </span>
      );
    case 'rejected':
    case 'error':
      return (
        <span aria-hidden="true" className="text-[10px] text-status-error">
          &#10005;
        </span>
      );
    case 'cancelled':
      return (
        <span aria-hidden="true" className="text-[10px] text-text-muted">
          &#8212;
        </span>
      );
  }
}

function statusLabel(status: ToolCallData['status']): string {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'waiting_for_confirmation':
      return 'waiting for confirmation';
    case 'completed':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'cancelled';
  }
}

function SingleToolCard({ tool, compact, defaultExpanded = false, onPermissionRespond }: SingleToolCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded || !compact);
  const panelId = useId();
  const hasContent = (tool.content?.length ?? 0) > 0;
  const hasRawOutput = Boolean(tool.rawOutput && Object.keys(tool.rawOutput).length > 0);
  const hasTerminal = tool.content?.some(item => item.type === 'terminal') ?? false;
  const showRawOutput = hasRawOutput && (hasTerminal || !rawOutputDuplicatesContent(tool));
  const hasDetails = Boolean(
    (tool.rawInput && Object.keys(tool.rawInput).length > 0) ||
      hasContent ||
      hasRawOutput ||
      terminalStatuses.has(tool.status),
  );

  return (
    <div className={cn('px-3 py-2', compact && 'py-1.5')}>
      <button
        aria-controls={panelId}
        aria-expanded={hasDetails && expanded}
        className="group flex w-full items-center gap-1.5 text-left"
        disabled={!hasDetails}
        onClick={() => setExpanded(value => !value)}
        type="button"
      >
        {statusMark(tool.status)}
        <span className="sr-only">{statusLabel(tool.status)}</span>
        <span className="truncate text-xs font-medium text-text-secondary transition-colors group-hover:text-text-primary">
          {tool.title}
        </span>
        {tool.status === 'in_progress' && (
          <span aria-hidden="true" className="animate-pulse text-[10px] text-status-running">
            {statusLabel(tool.status)}
          </span>
        )}
        {tool.status === 'queued' && (
          <span aria-hidden="true" className="text-[10px] text-text-muted">
            {statusLabel(tool.status)}
          </span>
        )}
      </button>

      {tool.status === 'waiting_for_confirmation' && tool.permissionRequest && (
        <div className="mt-1.5 ml-4">
          <ToolPermissionButtons
            onRespond={onPermissionRespond ?? (() => {})}
            options={tool.permissionRequest.options}
            requestId={tool.permissionRequest.requestId}
          />
        </div>
      )}

      <div className="mt-1.5 ml-4 max-h-72 space-y-2 overflow-auto pr-1" hidden={!expanded || !hasDetails} id={panelId}>
        {tool.rawInput && Object.keys(tool.rawInput).length > 0 && (
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-2 font-mono text-[11px] text-text-secondary">
            {JSON.stringify(tool.rawInput, null, 2)}
          </pre>
        )}
        {tool.content?.map((item, slot) => {
          const key = toolContentKey(tool.id, item, slot);
          return <ToolContent item={item} key={key} keyPrefix={key} />;
        })}
        {showRawOutput && (
          <pre
            className={cn(
              'overflow-auto whitespace-pre-wrap break-words rounded-md p-2 font-mono text-[11px]',
              tool.status === 'error' ? 'bg-status-error/10 text-status-error' : 'bg-surface-1 text-text-secondary',
            )}
          >
            {formatRawOutput(tool.rawOutput ?? {})}
          </pre>
        )}
        {!hasContent && !hasRawOutput && terminalStatuses.has(tool.status) && (
          <div className="rounded-md bg-surface-1 p-2 font-mono text-[11px] text-text-muted">(no output)</div>
        )}
      </div>
    </div>
  );
}

function ToolContent({ item, keyPrefix }: { item: ToolCallContent; keyPrefix: string }) {
  switch (item.type) {
    case 'content': {
      const block = toRenderableContentBlock(item.content);
      return block ? (
        <ContentBlockView blocks={[block]} keyPrefix={keyPrefix} mode="tool" />
      ) : (
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-2 font-mono text-[11px] text-text-secondary">
          {JSON.stringify(item.content, null, 2)}
        </pre>
      );
    }
    case 'diff':
      return <DiffContent item={item} />;
    case 'terminal':
      return <TerminalContent item={item} />;
  }
}

function DiffContent({ item }: { item: ToolCallDiffContent }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-1 text-[11px]">
      <div className="border-b border-border px-2 py-1 font-mono text-text-muted">{item.path}</div>
      <div className="grid gap-px bg-border sm:grid-cols-2">
        <pre className="overflow-auto whitespace-pre-wrap break-words bg-surface-1 p-2 text-status-error">
          {item.oldText ?? '(empty)'}
        </pre>
        <pre className="overflow-auto whitespace-pre-wrap break-words bg-surface-1 p-2 text-status-active">
          {item.newText}
        </pre>
      </div>
    </div>
  );
}

function TerminalContent({ item }: { item: ToolCallTerminalContent }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-[11px] text-text-muted">
      Terminal: {item.terminalId}
    </div>
  );
}

function toolContentKey(toolId: string, item: ToolCallContent, slot: number): string {
  return `${toolId}:${item.type}:${slot}`;
}

function formatRawOutput(output: Record<string, unknown>): string {
  return Object.keys(output).length === 1 && typeof output.output === 'string'
    ? output.output
    : JSON.stringify(output, null, 2);
}

function rawOutputDuplicatesContent(tool: ToolCallData): boolean {
  if (!tool.rawOutput || Object.keys(tool.rawOutput).length !== 1 || !('output' in tool.rawOutput)) return false;
  if (!tool.content?.every(item => item.type === 'content')) return false;
  const blocks = tool.content.map(item => item.content);
  const output = tool.rawOutput.output;
  if (typeof output === 'string' && blocks.length === 1) {
    const block = blocks[0];
    return block.type === 'text' && block.text === output;
  }
  if (blocks.length === 1 && JSON.stringify(blocks[0]) === JSON.stringify(output)) return true;
  return JSON.stringify(blocks) === JSON.stringify(output);
}

function buildSummary(entries: ToolCallEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const name = simplifyToolName(entry.toolCall.title);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts].map(([name, count]) => (count === 1 ? name : `${count} 次${name}`));
  if (parts.length === 0) return `${entries.length} 个工具调用`;
  if (parts.length === 1) return parts[0];
  return `${entries.length} 个工具: ${parts.join('、')}`;
}

function simplifyToolName(title: string): string {
  return title.match(/^(\w+)/)?.[1] ?? title;
}
