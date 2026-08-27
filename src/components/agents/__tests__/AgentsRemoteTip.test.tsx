import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToString } from '../../../utils/staticRender.js';

const agentsListModule = (await import('../AgentsList.js')) as {
  AgentsRemoteTip?: () => React.ReactNode;
};

describe('AgentsRemoteTip', () => {
  test('points scheduled remote agents to their unambiguous commands', async () => {
    expect(typeof agentsListModule.AgentsRemoteTip).toBe('function');
    const Tip = agentsListModule.AgentsRemoteTip;
    if (!Tip) return;

    const output = await renderToString(<Tip />);
    expect(output.replace(/\s+/g, ' ').trim()).toContain(
      'Tip: This screen manages local agent configurations. For scheduled remote agents, use /agents-platform or /schedule-agent.',
    );
  });
});
