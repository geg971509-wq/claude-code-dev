import { afterEach, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import type { Instance } from '../../core/root.js';
import { renderSync } from '../../core/root.js';
import ErrorOverview from '../ErrorOverview.js';

const mounted: Instance[] = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) {
    instance.unmount();
    instance.cleanup();
  }
});

test('repeated stack frames render without duplicate React keys', async () => {
  const error = new Error('boom');
  const repeatedFrame = '    at recurse (/tmp/example.ts:1:1)';
  error.stack = `Error: boom\n${repeatedFrame}\n${repeatedFrame}`;
  const stdout = new PassThrough();
  stdout.on('data', () => {});
  const reactErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => reactErrors.push(args);

  try {
    mounted.push(
      renderSync(<ErrorOverview error={error} />, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
      }),
    );
    await Bun.sleep(20);
    expect(reactErrors).toEqual([]);
  } finally {
    console.error = originalConsoleError;
  }
});
