import { Box, stringWidth, Text, useInput, wrapText } from '@anthropic/ink';
import figures from 'figures';
import * as React from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  buildAgentFleetSnapshot,
  dispatchAgentFleetAction,
  type AgentFleetAction,
  type AgentFleetActionResult,
  type AgentFleetRecord,
  type AgentFleetSnapshot,
} from '../../services/agentFleet/index.js';
import { useAppStateStore } from '../../state/AppState.js';
import { discoverPeerRoster } from '../../utils/peerDiscovery.js';
import { requestAgentFleetAction } from '../../utils/udsClient.js';
import { availableFleetActions, filterFleetRecords, fleetAction, fleetViewStatus } from './AgentFleetViewModel.js';

export {
  availableFleetActions,
  filterFleetRecords,
  fleetViewStatus,
} from './AgentFleetViewModel.js';

type Props = {
  onDefinitions: () => void;
  onExit: (result?: string) => void;
  loadSnapshot?: () => Promise<AgentFleetSnapshot>;
  dispatchAction?: (record: AgentFleetRecord, action: AgentFleetAction) => Promise<AgentFleetActionResult>;
  refreshIntervalMs?: number;
};

type InputMode = { type: 'filter' } | { type: 'action'; action: 'message' | 'resume' | 'retry' };

let fleetTipsShown = false;

async function defaultDispatch(record: AgentFleetRecord, action: AgentFleetAction): Promise<AgentFleetActionResult> {
  return record.socketPath
    ? requestAgentFleetAction(record.socketPath, action)
    : dispatchAgentFleetAction(record, action);
}

function recordName(record: AgentFleetRecord): string {
  return record.name ?? record.sessionId ?? record.rawId ?? record.id;
}

export function AgentFleetView({
  onDefinitions,
  onExit,
  loadSnapshot,
  dispatchAction = defaultDispatch,
  refreshIntervalMs = 2_000,
}: Props): React.ReactNode {
  const store = useAppStateStore();
  const { columns } = useTerminalSize();
  const [snapshot, setSnapshot] = React.useState<AgentFleetSnapshot>();
  const [selected, setSelected] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const [query, setQuery] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const [inputMode, setInputMode] = React.useState<InputMode>();
  const [detail, setDetail] = React.useState(false);
  const [showTips, setShowTips] = React.useState(() => {
    if (fleetTipsShown) return false;
    fleetTipsShown = true;
    return true;
  });
  const refreshingRef = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const next = await (loadSnapshot?.() ??
        buildAgentFleetSnapshot(
          process.cwd(),
          { all: true },
          {
            getTaskRecords: () => store.getState().tasks,
            getPeerRoster: () => discoverPeerRoster(store.getState()),
            ownerSessionId: getSessionId(),
          },
        ));
      setSnapshot(next);
      setError(undefined);
      setSelected(index => Math.min(index, Math.max(0, next.records.length - 1)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, [loadSnapshot, store]);

  React.useEffect(() => {
    void refresh();
    if (refreshIntervalMs <= 0) return;
    const timer = setInterval(() => void refresh(), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [refresh, refreshIntervalMs]);
  useExitOnCtrlCDWithKeybindings();

  const records = filterFleetRecords(snapshot?.records ?? [], query);
  const current = records[selected];
  const actions = current ? availableFleetActions(current) : [];

  const runAction = React.useCallback(
    async (record: AgentFleetRecord, action: AgentFleetAction): Promise<void> => {
      setNotice(`Running ${action.type}...`);
      try {
        const result = await dispatchAction(record, action);
        const output = result.ok && result.output;
        setNotice(
          result.ok
            ? output
              ? output.slice(-2_000)
              : `${action.type} completed for ${recordName(record)}.`
            : result.message,
        );
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
      }
      if (action.type !== 'logs' && action.type !== 'attach') void refresh();
    },
    [dispatchAction, refresh],
  );

  useInput((input, key) => {
    setShowTips(false);
    if (inputMode) {
      if (key.escape) {
        setInputMode(undefined);
        setDraft('');
      } else if (key.return) {
        if (inputMode.type === 'filter') {
          setQuery(draft);
          setSelected(0);
        } else if (current && draft.trim()) {
          void runAction(current, fleetAction(current, inputMode.action, draft));
        } else {
          setNotice('Input is required.');
        }
        setInputMode(undefined);
        setDraft('');
      } else if (key.backspace || key.delete) {
        setDraft(value => value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDraft(value => value + input);
      }
      return;
    }
    if (key.escape && detail) {
      setDetail(false);
      return;
    }
    if (input === 'd') return onDefinitions();
    if (input === 'r') return void refresh();
    if (input === '/') {
      setDraft(query);
      setInputMode({ type: 'filter' });
      return;
    }
    if (input === 'q' || key.escape) return onExit('Agents dialog dismissed');
    if (key.return && current) return setDetail(value => !value);
    if (key.upArrow) setSelected(index => Math.max(0, index - 1));
    if (key.downArrow) setSelected(index => Math.min(Math.max(0, records.length - 1), index + 1));
    const action = actions.find(candidate => candidate.key === input);
    if (!action || !current) return;
    if (action.type === 'message' || action.type === 'resume' || action.type === 'retry') {
      setInputMode({ type: 'action', action: action.type });
      return;
    }
    void runAction(current, fleetAction(current, action.type));
  });

  const status = fleetViewStatus(snapshot, loading, error);
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Text bold>Running agents</Text>
      {showTips && (
        <Text dimColor>Tips: ↑↓ select · Enter details · / filter · r refresh · d definitions · Esc back</Text>
      )}
      {inputMode && (
        <Text color="suggestion">
          {inputMode.type === 'filter' ? 'Filter' : inputMode.action}: {draft}
          {figures.pointer}
        </Text>
      )}
      {query && !inputMode && <Text dimColor>Filter: {query} · / edit</Text>}
      {refreshing && snapshot && <Text dimColor>Refreshing...</Text>}
      {status === 'loading' && <Text dimColor>Loading agents...</Text>}
      {status === 'error' && <Text color="error">Fleet unavailable: {error}</Text>}
      {status === 'stale' && <Text color="warning">Stale data: {error}</Text>}
      {status === 'partial' && (
        <Text color="warning">Partial results · unavailable: {snapshot?.unavailableSources.join(', ')}</Text>
      )}
      {notice && <Text color="warning">{notice}</Text>}
      {status === 'empty' ? (
        <Text dimColor>No running agents.</Text>
      ) : records.length === 0 && snapshot ? (
        <Text dimColor>No agents match this filter.</Text>
      ) : detail && current ? (
        <Box flexDirection="column">
          <Text bold>{recordName(current)}</Text>
          <Text>
            State: {current.state} · Source: {current.source}
          </Text>
          <Text>
            Kind: {current.kind ?? 'unknown'} · Status: {current.status ?? 'unknown'}
          </Text>
          <Text>CWD: {current.cwd ?? 'unknown'}</Text>
          <Text>ID: {current.sessionId ?? current.rawId ?? current.id}</Text>
          <Text dimColor>
            {actions.length
              ? actions.map(action => `${action.key} ${action.label}`).join(' · ')
              : 'No actions available'}
            {' · Enter/Esc back'}
          </Text>
        </Box>
      ) : (
        records.map((record, index) => {
          const rowWidth = Math.max(1, columns - 4);
          const status = wrapText(` · ${record.state} · ${record.source}`, Math.max(1, rowWidth - 1), 'truncate-end');
          const name = wrapText(recordName(record), Math.max(1, rowWidth - stringWidth(status)), 'truncate-end');
          const cwdWidth = rowWidth - stringWidth(name) - stringWidth(status) - 3;
          const cwd = record.cwd && cwdWidth >= 12 ? ` · ${wrapText(record.cwd, cwdWidth, 'truncate-middle')}` : '';
          return (
            <Box key={record.id}>
              <Text color={index === selected ? 'suggestion' : undefined}>
                {index === selected ? `${figures.pointer} ` : '  '}
              </Text>
              <Text>{name}</Text>
              <Text dimColor>
                {status}
                {cwd}
              </Text>
            </Box>
          );
        })
      )}
      {!detail && current && <Text dimColor>{actions.map(action => `${action.key} ${action.label}`).join(' · ')}</Text>}
    </Box>
  );
}
