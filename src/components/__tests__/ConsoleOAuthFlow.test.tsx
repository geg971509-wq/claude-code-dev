import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..');

async function runIsolated(source: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, '-e', source], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output: `${stdout}\n${stderr}` };
}

describe('ConsoleOAuthFlow OAuth URL lifecycle', () => {
  test('owns prompt, copied reset, and clipboard completion by the active URL', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test';
      import { PassThrough } from 'node:stream';
      import * as React from 'react';

      const flows = [];
      const clipboardCompletions = [];
      const clipboardUrls = [];
      const clearedAtServiceCleanup = [];
      const rendered = [];
      let confirmationHandler;
      let textInputOnChange;
      let activeTimers;

      class FakeTimers {
        now = 0;
        nextId = 1;
        timers = new Map();
        scheduled = [];
        cleared = [];
        originalSetTimeout = globalThis.setTimeout;
        originalClearTimeout = globalThis.clearTimeout;

        install() {
          globalThis.setTimeout = (callback, delay = 0, ...args) => {
            if (delay < 1000) return this.originalSetTimeout(callback, delay, ...args);
            const record = {
              id: this.nextId++,
              dueAt: this.now + delay,
              delay,
              callback: () => callback(...args),
            };
            this.timers.set(record.id, record);
            this.scheduled.push(record);
            return record.id;
          };
          globalThis.clearTimeout = timer => {
            if (this.timers.delete(timer)) this.cleared.push(timer);
            else this.originalClearTimeout(timer);
          };
        }

        restore() {
          globalThis.setTimeout = this.originalSetTimeout;
          globalThis.clearTimeout = this.originalClearTimeout;
        }

        advanceBy(ms) {
          const target = this.now + ms;
          while (true) {
            const due = [...this.timers.values()]
              .filter(timer => timer.dueAt <= target)
              .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
            if (!due) break;
            this.now = due.dueAt;
            this.timers.delete(due.id);
            due.callback();
          }
          this.now = target;
        }
      }

      function assert(condition, message) {
        if (!condition) throw new Error(message);
      }

      function queueFlow(url) {
        const flow = { url, result: Promise.withResolvers() };
        flows.push(flow);
        return flow;
      }

      function queueClipboardCompletion() {
        const completion = Promise.withResolvers();
        clipboardCompletions.push(completion);
        return completion;
      }

      async function flush() {
        for (let i = 0; i < 3; i++) {
          await Promise.resolve();
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // Ink throttles frame writes, so frame assertions need a real macrotask gap.
      async function painted() {
        await flush();
        await new Promise(resolve => setTimeout(resolve, 40));
        await flush();
      }

      mock.module('src/services/oauth/index.js', () => ({
        OAuthService: class {
          async startOAuthFlow(onUrl) {
            const flow = flows.shift();
            if (!flow) throw new Error('Missing mocked OAuth flow');
            await onUrl(flow.url);
            return flow.result.promise;
          }

          cleanup() {
            clearedAtServiceCleanup.push(activeTimers.cleared.slice());
          }

          handleManualAuthCodeInput() {}
        },
      }));

      mock.module('src/hooks/useTerminalSize.js', () => ({ useTerminalSize: () => ({ columns: 120, rows: 24 }) }));
      const realKeybindings = await import('src/keybindings/useKeybinding.js');
      mock.module('src/keybindings/useKeybinding.js', () => ({
        ...realKeybindings,
        useKeybinding(_key, handler, options) {
          if (options.context === 'Confirmation' && options.isActive !== false) confirmationHandler = handler;
        },
      }));
      const realAnalytics = await import('src/services/analytics/index.js');
      mock.module('src/services/analytics/index.js', () => ({ ...realAnalytics, logEvent() {} }));
      const realSpinner = await import('src/components/Spinner.js');
      mock.module('src/components/Spinner.js', () => ({ ...realSpinner, Spinner: () => null }));
      mock.module('src/components/TextInput.js', () => ({
        default: ({ onChange }) => {
          React.useEffect(() => {
            textInputOnChange = onChange;
            return () => {
              if (textInputOnChange === onChange) textInputOnChange = undefined;
            };
          }, [onChange]);
          return null;
        },
      }));

      const realInk = await import('@anthropic/ink');
      mock.module('@anthropic/ink', () => ({
        ...realInk,
        setClipboard(url) {
          clipboardUrls.push(url);
          const completion = clipboardCompletions.shift();
          if (!completion) throw new Error('Missing mocked clipboard completion');
          return completion.promise;
        },
        useTerminalNotification: () => undefined,
      }));

      const { ConsoleOAuthFlow } = await import('src/components/ConsoleOAuthFlow.tsx');

      async function renderFlow() {
        const stdout = new PassThrough();
        const frames = [];
        stdout.on('data', chunk => frames.push(String(chunk)));
        const instance = await realInk.wrappedRender(
          React.createElement(ConsoleOAuthFlow, { mode: 'setup-token', onDone() {} }),
          { stdout, patchConsole: false },
        );
        const view = { instance, frames };
        rendered.push(view);
        return view;
      }

      function writtenSince(view, mark) {
        return view.frames.slice(mark).join('');
      }

      const timers = new FakeTimers();
      activeTimers = timers;
      timers.install();

      try {
        const flowA = queueFlow('https://oauth.example/A');
        queueFlow('https://oauth.example/B');
        const clipboardA = queueClipboardCompletion();
        const retry = await renderFlow();
        await flush();
        timers.advanceBy(3000);
        await flush();
        assert(textInputOnChange, 'Expected A paste prompt after 3s');

        textInputOnChange('c');
        await flush();
        assert(JSON.stringify(clipboardUrls) === JSON.stringify([flowA.url]), 'Expected clipboard copy for A');

        flowA.result.reject(new Error('OAuth A failed'));
        await flush();
        assert(confirmationHandler, 'Expected retry confirmation handler');
        confirmationHandler();
        await flush();
        timers.advanceBy(1000);
        await flush();
        assert(!textInputOnChange, 'B inherited the A paste prompt');

        timers.advanceBy(3000);
        await flush();
        assert(textInputOnChange, 'Expected B paste prompt after its own 3s');

        const markBeforeLateCopy = retry.frames.length;
        clipboardA.resolve(undefined);
        await painted();
        assert(
          !writtenSince(retry, markBeforeLateCopy).includes('(Copied!)'),
          'Late A clipboard completion marked B copied',
        );
        retry.instance.unmount();
        await flush();

        queueFlow('https://oauth.example/paste');
        const pasteOnly = await renderFlow();
        await flush();
        const pasteTimer = timers.scheduled.at(-1);
        assert(pasteTimer && pasteTimer.delay === 3000, 'Expected a 3s paste prompt timer');
        pasteOnly.instance.unmount();
        await flush();
        assert(timers.cleared.includes(pasteTimer.id), 'Unmount did not clear the paste prompt timer');
        assert(
          clearedAtServiceCleanup.at(-1)?.includes(pasteTimer.id),
          'OAuth service cleanup ran before the paste prompt timer was cleared',
        );

        queueFlow('https://oauth.example/copied');
        const copiedClipboard = queueClipboardCompletion();
        const copied = await renderFlow();
        await flush();
        timers.advanceBy(3000);
        await flush();
        assert(textInputOnChange, 'Expected paste prompt for the copied flow');
        const markBeforeCopy = copied.frames.length;
        textInputOnChange('c');
        await flush();
        copiedClipboard.resolve(undefined);
        await painted();
        assert(writtenSince(copied, markBeforeCopy).includes('(Copied!)'), 'Expected the copied indicator');
        const copiedTimer = timers.scheduled.at(-1);
        assert(copiedTimer && copiedTimer.delay === 2000, 'Expected a 2s copied reset timer');
        copied.instance.unmount();
        await flush();
        assert(timers.cleared.includes(copiedTimer.id), 'Unmount did not clear the copied reset timer');
        assert(
          clearedAtServiceCleanup.at(-1)?.includes(copiedTimer.id),
          'OAuth service cleanup ran before the copied reset timer was cleared',
        );
        console.log('ok');
      } finally {
        for (const view of rendered) view.instance.unmount();
        for (const flow of flows) flow.result.resolve({ accessToken: 'cancelled' });
        for (const completion of clipboardCompletions) completion.resolve(undefined);
        await flush();
        timers.restore();
      }
    `);

    expect(code).toBe(0);
    expect(output).toContain('ok');
  });
});
