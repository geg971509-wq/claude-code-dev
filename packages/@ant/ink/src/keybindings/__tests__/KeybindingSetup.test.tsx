import { afterEach, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { renderSync, type Instance } from '../../core/root.js';
import useInput from '../../hooks/use-input.js';
import { KeybindingSetup } from '../KeybindingSetup.js';
import { parseBindings } from '../parser.js';
import type { KeybindingBlock } from '../types.js';

const mounted: Instance[] = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) {
    instance.unmount();
    instance.cleanup();
  }
});

function InputProbe({ onInput }: { onInput: (input: string) => void }) {
  useInput(onInput);
  return null;
}

async function renderKeybindings(blocks: KeybindingBlock[]) {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const stdout = new PassThrough();
  stdout.on('data', () => {});
  const received: string[] = [];
  const instance = renderSync(
    <KeybindingSetup
      loadBindings={() => ({ bindings: parseBindings(blocks), warnings: [] })}
      subscribeToChanges={() => () => {}}
    >
      <InputProbe onInput={input => received.push(input)} />
    </KeybindingSetup>,
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
  );
  mounted.push(instance);
  await Bun.sleep(10);
  return { stdin, received };
}

test('single-key null override propagates to ordinary input', async () => {
  const { stdin, received } = await renderKeybindings([{ context: 'Global', bindings: { ' ': null } }]);

  stdin.write(' ');
  await Bun.sleep(10);

  expect(received).toEqual([' ']);
});

test('null override reached during a chord consumes the key', async () => {
  const { stdin, received } = await renderKeybindings([
    {
      context: 'Global',
      bindings: {
        'ctrl+k x': null,
        'ctrl+k y': 'test:activeChord',
      },
    },
  ]);

  stdin.write('\u000b');
  await Bun.sleep(10);
  stdin.write('x');
  await Bun.sleep(10);

  expect(received).toEqual([]);
});
