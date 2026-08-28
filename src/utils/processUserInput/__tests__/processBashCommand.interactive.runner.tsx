import { createRoot, useInput } from '@anthropic/ink';
import { mock } from 'bun:test';
import type { ProcessUserInputContext } from '../processUserInput.js';
import { debugMock } from '../../../../tests/mocks/debug.js';
import { logMock } from '../../../../tests/mocks/log.js';

mock.module('bun:bundle', () => ({ feature: () => false }));
mock.module('src/utils/debug.ts', debugMock);
mock.module('src/utils/log.ts', logMock);

let root: Awaited<ReturnType<typeof createRoot>>;

function InputProbe(): null {
  useInput(value => {
    if (value === 'x') {
      process.stdout.write('SESSION_ALIVE\n');
      root.unmount();
    }
  });
  return null;
}

root = await createRoot({ exitOnCtrlC: false });
root.render(<InputProbe />);
await Bun.sleep(50);

const { processBashCommand } = await import('../processBashCommand.js');
const abortController = new AbortController();
const abortTimer = setTimeout(() => abortController.abort('test-timeout'), 10_000);
const hardExitTimer = setTimeout(() => process.exit(124), 15_000);
const toolPermissionContext = {
  mode: 'bypassPermissions',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: true,
};
const context = {
  options: {
    isNonInteractiveSession: false,
    verbose: false,
  },
  abortController,
  getAppState: () => ({ toolPermissionContext, tasks: {} }),
  setAppState: () => {},
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  readFileState: new Map(),
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
  messages: [],
} as unknown as ProcessUserInputContext;

const result = await processBashCommand(
  `test -t 0 || exit 41
printf 'COMMAND_STDIN_READY\\n' >/dev/tty
while IFS= read -r first; do [ "$first" = stdin-ok ] && break; done
[ "$first" = stdin-ok ] || exit 42
printf 'COMMAND_STDIN_ACK\\n' >/dev/tty
printf 'COMMAND_TTY_READY\\n' >/dev/tty
while IFS= read -r second </dev/tty; do [ "$second" = tty-ok ] && break; done
[ "$second" = tty-ok ] || exit 43
printf 'COMMAND_TTY_ACK\\n' >/dev/tty
printf 'CAPTURED:%s:%s\\n' "$first" "$second"`,
  [],
  [],
  context,
  () => {},
);

const serialized = JSON.stringify(result.messages);
if (!serialized.includes('CAPTURED:stdin-ok:tty-ok')) {
  throw new Error(`interactive output was not captured: ${serialized}`);
}
clearTimeout(abortTimer);
process.stdout.write('BANG_DONE\n');

await root.waitUntilExit();
clearTimeout(hardExitTimer);
process.exit(0);
