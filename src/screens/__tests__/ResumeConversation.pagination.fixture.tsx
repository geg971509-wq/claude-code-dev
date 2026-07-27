import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import * as React from 'react';
import { wrappedRender as render } from '@anthropic/ink';
import { logMock } from '../../../tests/mocks/log';
import type { LogOption } from '../../types/logs.js';
import type { SessionLogResult } from '../../utils/sessionStorage.js';

type SelectorProps = {
  logs: LogOption[];
  onLoadMore: (count: number) => void;
  onToggleAllProjects: () => void;
};

const sameRepoLoads: Array<Promise<SessionLogResult>> = [];
const allProjectLoads: Array<Promise<SessionLogResult>> = [];
const enrichCalls: Array<{
  logs: LogOption[];
  startIndex: number;
  count: number;
}> = [];
const enrichLoads: Array<Promise<{ logs: LogOption[]; nextIndex: number }>> = [];
let selectorProps: SelectorProps | undefined;

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function makeLog(id: string, value: number): LogOption {
  return {
    date: '2026-01-01',
    messages: [],
    value,
    created: new Date(0),
    modified: new Date(0),
    firstPrompt: id,
    messageCount: 1,
    isSidechain: false,
    sessionId: id,
  };
}

function makeResult(prefix: string): SessionLogResult {
  const logs = Array.from({ length: 50 }, (_, value) => makeLog(`${prefix}-${value}`, value));
  return {
    logs,
    allStatLogs: [
      ...logs,
      ...Array.from({ length: 50 }, (_, value) => makeLog(`${prefix}-later-${value}`, value + 50)),
    ],
    nextIndex: 50,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

mock.module('bun:bundle', () => ({ feature: () => false }));
mock.module('src/hooks/useTerminalSize.js', () => ({ useTerminalSize: () => ({ rows: 24 }) }));
mock.module('src/components/LogSelector.js', () => ({
  LogSelector: (props: SelectorProps) => {
    selectorProps = props;
    return React.createElement('log-selector');
  },
}));
mock.module('src/components/Spinner.js', () => ({ Spinner: () => React.createElement('spinner') }));
const realCostTracker = await import('../../cost-tracker.js');
mock.module('src/cost-tracker.js', () => ({
  ...realCostTracker,
  restoreCostStateForSession: () => {},
}));
mock.module('src/keybindings/useKeybinding.js', () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}));
mock.module('src/services/analytics/index.js', () => ({
  attachAnalyticsSink: () => {},
  logEvent: () => {},
  logEventAsync: async () => {},
  stripProtoFields: <T,>(value: T) => value,
}));
mock.module('src/state/AppState.js', () => ({
  AppStateProvider: ({ children }: { children: React.ReactNode }) => children,
  AppStoreContext: React.createContext(null),
  useAppState: (selector: (state: { agentDefinitions: unknown[] }) => unknown) => selector({ agentDefinitions: [] }),
  useAppStateMaybeOutsideOfProvider: () => undefined,
  useAppStateStore: () => ({ getState: () => ({}), setState: () => {} }),
  useSetAppState: () => () => {},
}));
mock.module('src/utils/agenticSessionSearch.js', () => ({ agenticSessionSearch: async () => [] }));
mock.module('src/utils/asciicast.js', () => ({ renameRecordingForSession: async () => {} }));
mock.module('src/utils/concurrentSessions.js', () => ({ updateSessionName: async () => {} }));
const realConversationRecovery = await import('../../utils/conversationRecovery.js');
mock.module('src/utils/conversationRecovery.js', () => ({
  ...realConversationRecovery,
  loadConversationForResume: async () => null,
}));
mock.module('src/utils/crossProjectResume.js', () => ({
  checkCrossProjectResume: () => ({ isCrossProject: false }),
}));
mock.module('src/utils/log.js', logMock);
mock.module('src/utils/sessionRestore.js', () => ({
  computeStandaloneAgentContext: () => undefined,
  restoreAgentFromSession: () => undefined,
  restoreWorktreeForResume: () => {},
}));
const realSessionStorage = await import('../../utils/sessionStorage.js');
mock.module('src/utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  enrichLogs: (logs: LogOption[], startIndex: number, count: number) => {
    enrichCalls.push({ logs, startIndex, count });
    return enrichLoads.shift()!;
  },
  isCustomTitleEnabled: () => false,
  loadAllProjectsMessageLogsProgressive: () => allProjectLoads.shift()!,
  loadSameRepoMessageLogsProgressive: () => sameRepoLoads.shift()!,
}));
mock.module('../REPL.js', () => ({ REPL: () => React.createElement('repl') }));

const { ResumeConversation } = await import('../ResumeConversation.js');

function renderResumeConversation() {
  const stdout = new PassThrough();
  stdout.on('data', () => {});
  return render(
    <ResumeConversation
      commands={[]}
      worktreePaths={[]}
      initialTools={[]}
      debug={false}
      thinkingConfig={{} as never}
    />,
    { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
  );
}

beforeEach(() => {
  sameRepoLoads.length = 0;
  allProjectLoads.length = 0;
  enrichCalls.length = 0;
  enrichLoads.length = 0;
  selectorProps = undefined;
});

afterEach(() => {
  selectorProps = undefined;
});

describe('ResumeConversation progressive pagination', () => {
  test('shares one near-tail page load for the current result', async () => {
    const initial = makeResult('initial');
    const page = deferred<{ logs: LogOption[]; nextIndex: number }>();
    sameRepoLoads.push(Promise.resolve(initial));
    enrichLoads.push(page.promise);
    const instance = await renderResumeConversation();

    try {
      await flush();
      const loadMore = selectorProps?.onLoadMore;
      expect(loadMore).toBeDefined();
      loadMore?.(10);
      loadMore?.(10);

      expect(enrichCalls).toHaveLength(1);
      expect(enrichCalls[0]).toMatchObject({
        logs: initial.allStatLogs,
        startIndex: 50,
        count: 10,
      });

      page.resolve({ logs: [makeLog('initial-page', 50)], nextIndex: 60 });
      await flush();
    } finally {
      instance.unmount();
    }
  });

  test('does not append an old scope page while the scope reload is still in flight', async () => {
    const initial = makeResult('same-repo');
    const replacement = makeResult('all-projects');
    const reload = deferred<SessionLogResult>();
    const oldPage = deferred<{ logs: LogOption[]; nextIndex: number }>();
    const strandedPage = deferred<{ logs: LogOption[]; nextIndex: number }>();
    sameRepoLoads.push(Promise.resolve(initial));
    allProjectLoads.push(reload.promise);
    enrichLoads.push(oldPage.promise, strandedPage.promise);
    const instance = await renderResumeConversation();

    try {
      await flush();
      selectorProps?.onLoadMore(10);
      expect(enrichCalls).toHaveLength(1);

      // Toggle scope but leave the replacement load pending, then land the old
      // page inside that window. Only the synchronous invalidation in loadLogs
      // can reject it here — the replacement result does not exist yet.
      selectorProps?.onToggleAllProjects();
      await flush();
      // An empty page takes the loop's continuation branch, which is the only
      // path that re-reads the owner. A retired owner must end the loop here
      // instead of paging on through the abandoned scope.
      oldPage.resolve({ logs: [], nextIndex: 60 });
      await flush();
      expect(enrichCalls).toHaveLength(1);

      reload.resolve(replacement);
      await flush();
      expect(selectorProps?.logs[0]?.firstPrompt).toBe('all-projects-0');
      expect(enrichCalls).toHaveLength(1);
    } finally {
      instance.unmount();
    }
  });

  test('does not append an old scope page after a scope reload', async () => {
    const initial = makeResult('same-repo');
    const replacement = makeResult('all-projects');
    const oldPage = deferred<{ logs: LogOption[]; nextIndex: number }>();
    sameRepoLoads.push(Promise.resolve(initial));
    allProjectLoads.push(Promise.resolve(replacement));
    enrichLoads.push(oldPage.promise);
    const instance = await renderResumeConversation();

    try {
      await flush();
      selectorProps?.onLoadMore(10);
      expect(enrichCalls).toHaveLength(1);

      selectorProps?.onToggleAllProjects();
      await flush();
      oldPage.resolve({ logs: [makeLog('old-scope-page', 50)], nextIndex: 60 });
      await flush();

      expect(selectorProps?.logs).toHaveLength(50);
      expect(selectorProps?.logs.some(log => log.firstPrompt === 'old-scope-page')).toBe(false);
      expect(selectorProps?.logs[0]?.firstPrompt).toBe('all-projects-0');
    } finally {
      instance.unmount();
    }
  });
});
