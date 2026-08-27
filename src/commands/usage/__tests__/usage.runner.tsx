import { expect, mock, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React, { type ReactElement } from 'react';
import { authMockWith } from '../../../../tests/mocks/auth.js';
import { debugMock } from '../../../../tests/mocks/debug.js';
import { logMock } from '../../../../tests/mocks/log.js';

mock.module('bun:bundle', () => ({ feature: () => false }));
mock.module('src/utils/debug.ts', debugMock);
mock.module('src/utils/log.ts', logMock);
mock.module('src/components/Settings/Status.tsx', () => ({
  Status: () => null,
  buildDiagnostics: async () => [],
}));
mock.module('src/components/Spinner.tsx', () => ({ Spinner: () => null }));
mock.module('src/utils/auth.ts', await authMockWith({ isClaudeAISubscriber: () => false }));

const { findCommand } = await import('../../../commands.js');
const usageCommand = (await import('../index.js')).default;
const usageModule = await import('../usage.js');
const { Settings } = await import('../../../components/Settings/Settings.js');
const { KeybindingSetup, parseBindings, renderSync } = await import('@anthropic/ink');
const { processSlashCommand } = await import('../../../utils/processUserInput/processSlashCommand.js');

function expectedTab(commandName: string): 'Usage' | 'Stats' {
  return commandName === 'stats' ? 'Stats' : 'Usage';
}

test('/stats opens Stats while /usage and /cost retain the Usage route', async () => {
  for (const commandName of ['usage', 'cost', 'stats']) {
    const renderedElements: ReactElement<{ defaultTab: string }>[] = [];
    const command = {
      ...usageCommand,
      load: async () => ({
        call: async (...args: Parameters<typeof usageModule.call>) => {
          const rendered = (await usageModule.call(...args)) as ReactElement<{
            defaultTab: string;
          }>;
          renderedElements.push(rendered);
          args[0](undefined, { display: 'skip' });
          return rendered;
        },
      }),
    };

    expect(findCommand(commandName, [command])).toBe(command);

    const result = await processSlashCommand(
      `/${commandName}`,
      [],
      [],
      [],
      {
        getAppState: () => ({
          mcp: { clients: [] },
          toolPermissionContext: { mode: 'default', alwaysAllowRules: {} },
        }),
        options: {
          commands: [command],
          tools: [],
          refreshTools: () => [],
          isNonInteractiveSession: false,
        },
      } as never,
      () => undefined,
      undefined,
      false,
      async () => ({ behavior: 'allow', updatedInput: {} }) as never,
    );

    expect(result.shouldQuery).toBe(false);
    const rendered = renderedElements.at(-1);
    expect(rendered).toBeDefined();
    expect(rendered?.type).toBe(Settings);
    expect(rendered?.props.defaultTab).toBe(expectedTab(commandName));
  }
});

test('Settings Stats content closes through the Settings keybinding context', async () => {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const stdout = new PassThrough();
  const frames: string[] = [];
  stdout.on('data', chunk => frames.push(String(chunk)));
  const dismissals: Array<[string | undefined, unknown]> = [];
  const instance = renderSync(
    <KeybindingSetup
      loadBindings={() => ({
        bindings: parseBindings([{ context: 'Settings', bindings: { escape: 'confirm:no' } }]),
        warnings: [],
      })}
      subscribeToChanges={() => () => undefined}
    >
      <Settings
        onClose={(message, options) => dismissals.push([message, options])}
        context={{} as never}
        defaultTab="Stats"
      />
    </KeybindingSetup>,
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
  );

  try {
    await Bun.sleep(10);
    expect(frames.join('')).toContain('Loading your Claude Code stats');
    stdin.write('\u001b');
    await Bun.sleep(100);
    expect(dismissals).toEqual([['Stats dialog dismissed', { display: 'system' }]]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
