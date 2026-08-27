import { describe, test } from 'bun:test';
import { relative, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '../../../..');
const runner = `./${relative(projectRoot, resolve(import.meta.dir, 'usage.runner.tsx')).replaceAll('\\', '/')}`;

describe('usage command routing', () => {
  test('/stats opens Stats while /usage and /cost retain the Usage route', async () => {
    const proc = Bun.spawn(['bun', 'test', runner], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'test-key',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const output = `${await new Response(proc.stderr).text()}\n${await new Response(proc.stdout).text()}`;
      throw new Error(`usage subprocess failed (exit ${exitCode}):\n${output.slice(-3000)}`);
    }
  }, 60_000);
});
