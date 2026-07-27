import { expect, test } from 'bun:test';

const fixture = './src/screens/__tests__/ResumeConversation.pagination.fixture.tsx';

test('ResumeConversation progressive pagination', async () => {
  const child = Bun.spawn([process.execPath, 'test', '--timeout', '10000', '--bail', fixture], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`${stdout}${stderr}`);
  }

  expect(exitCode).toBe(0);
});
