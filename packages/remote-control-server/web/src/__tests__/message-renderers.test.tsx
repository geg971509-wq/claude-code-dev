import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../../components/chat/ChatView';
import { ContentBlockView, contentBlockKey } from '../../components/chat/ContentBlockView';
import { assistantChunkKey } from '../../components/chat/MessageBubble';
import { ToolCallGroup } from '../../components/chat/ToolCallGroup';
import { prefersReducedMotion } from '../../components/ai-elements/reasoning';
import type { AssistantMessageEntry, RenderableContentBlock, ToolCallEntry, UserMessageEntry } from '../lib/types';
import { toRenderableContentBlock } from '../lib/thread-state';

const image = {
  type: 'image' as const,
  mimeType: 'image/png',
  data: 'aW1hZ2U=',
};

const resource = {
  type: 'resource_link' as const,
  uri: 'https://example.com/report.md',
  name: 'report.md',
  title: 'Report',
  description: 'Build report',
  mimeType: 'text/markdown',
  size: 42,
};

const audio = {
  type: 'audio' as const,
  mimeType: 'audio/mpeg',
  data: '//uQZA==',
};

function positions(html: string, values: string[]): number[] {
  return values.map(value => html.indexOf(value));
}

function expectInOrder(html: string, values: string[]) {
  const found = positions(html, values);
  expect(found.every(position => position >= 0)).toBe(true);
  expect(found).toEqual([...found].sort((a, b) => a - b));
}

function tool(
  id: string,
  content: ToolCallEntry['toolCall']['content'],
  rawOutput?: Record<string, unknown>,
): ToolCallEntry {
  return {
    type: 'tool_call',
    toolCall: {
      id,
      title: `Tool ${id}`,
      status: 'completed',
      content,
      rawOutput,
    },
  };
}

describe('message renderers', () => {
  test('keeps streaming block and chunk keys stable as text grows without colliding across slots', () => {
    const shortText = { type: 'text' as const, text: 'partial' };
    const longerText = { type: 'text' as const, text: 'partial response with another streamed delta' };
    const shortThought = { type: 'thought' as const, text: 'working' };
    const longerThought = { type: 'thought' as const, text: 'working through another streamed delta' };
    const shortAudio = { ...audio, playable: true };
    const longerAudio = { ...audio, data: '//uQZAAA', playable: true };

    expect(contentBlockKey('assistant-1:message:0', shortText, 0)).toBe(
      contentBlockKey('assistant-1:message:0', longerText, 0),
    );
    expect(contentBlockKey('assistant-1:message:0', shortText, 0)).not.toBe(
      contentBlockKey('assistant-1:message:0', longerText, 1),
    );
    expect(assistantChunkKey('assistant-1', shortThought, 0)).toBe(assistantChunkKey('assistant-1', longerThought, 0));
    expect(assistantChunkKey('assistant-1', shortThought, 0)).not.toBe(
      assistantChunkKey('assistant-1', longerThought, 1),
    );
    expect(contentBlockKey('assistant-1:message:1', shortAudio, 0)).toBe(
      contentBlockKey('assistant-1:message:1', longerAudio, 0),
    );
  });

  test('renders mixed user content in source order without a text-only compatibility path', () => {
    const entry: UserMessageEntry = {
      type: 'user_message',
      id: 'user-1',
      deliveryState: 'sent',
      content: [{ type: 'text', text: 'USER_START' }, image, resource, { type: 'text', text: 'USER_END' }],
    };
    const html = renderToStaticMarkup(<ChatView entries={[entry]} phase="idle" activeAssistantId={null} />);

    expectInOrder(html, ['USER_START', 'Uploaded image', 'Report', 'USER_END']);
    expect(html).toContain('href="https://example.com/report.md"');
  });

  test('renders assistant mixed content in source order and does not link unsafe resource URIs', () => {
    const renderableAudio = toRenderableContentBlock(audio);
    expect(renderableAudio).not.toBeNull();
    const entry: AssistantMessageEntry = {
      type: 'assistant_message',
      id: 'assistant-1',
      state: 'completed',
      chunks: [
        {
          type: 'message',
          content: [
            { type: 'text', text: 'ASSISTANT_START' },
            image,
            renderableAudio!,
            { ...resource, uri: 'file:///tmp/report.md' },
            { type: 'text', text: 'ASSISTANT_END' },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(<ChatView entries={[entry]} phase="idle" activeAssistantId={null} />);

    expectInOrder(html, ['ASSISTANT_START', 'Uploaded image', 'Audio attachment', 'Report', 'ASSISTANT_END']);
    expect(html).toContain('controls=""');
    expect(html).toContain('src="data:audio/mpeg;base64,//uQZA=="');
    expect(html).not.toContain('href="file:///tmp/report.md"');
  });

  test('marks only the active assistant thought as streaming', () => {
    const entries: AssistantMessageEntry[] = [
      {
        type: 'assistant_message',
        id: 'old',
        state: 'completed',
        chunks: [{ type: 'thought', text: 'HISTORICAL_THOUGHT' }],
      },
      {
        type: 'assistant_message',
        id: 'active',
        state: 'streaming',
        chunks: [
          { type: 'thought', text: 'EARLIER_ACTIVE_THOUGHT' },
          {
            type: 'message',
            content: [{ type: 'text', text: 'partial answer' }],
          },
          { type: 'thought', text: 'ACTIVE_THOUGHT' },
        ],
      },
    ];
    const html = renderToStaticMarkup(<ChatView entries={entries} phase="thinking" activeAssistantId="active" />);

    expect(html).toContain('ACTIVE_THOUGHT');
    expect(html).not.toContain('EARLIER_ACTIVE_THOUGHT');
    expect(html).not.toContain('HISTORICAL_THOUGHT');
    expect((html.match(/Thinking\.\.\./g) ?? []).length).toBe(1);
  });

  test('shows the pre-response indicator only while requesting without an active assistant', () => {
    const entry: UserMessageEntry = {
      type: 'user_message',
      id: 'user-1',
      content: [{ type: 'text', text: 'hello' }],
      deliveryState: 'sent',
    };
    const requesting = renderToStaticMarkup(<ChatView entries={[entry]} phase="requesting" activeAssistantId={null} />);
    const usingTool = renderToStaticMarkup(<ChatView entries={[entry]} phase="using_tool" activeAssistantId={null} />);

    expect(requesting).toContain('data-thread-indicator="requesting"');
    expect(usingTool).not.toContain('data-thread-indicator="requesting"');
  });

  test('renders tool text, image, and resource blocks in source order', () => {
    const entry = tool('mixed', [
      { type: 'content', content: { type: 'text', text: 'TOOL_START' } },
      { type: 'content', content: image },
      { type: 'content', content: audio },
      { type: 'content', content: resource },
      { type: 'content', content: { type: 'text', text: 'TOOL_END' } },
    ]);
    const html = renderToStaticMarkup(<ToolCallGroup entries={[entry]} defaultExpanded />);

    expectInOrder(html, ['TOOL_START', 'Uploaded image', 'Audio attachment', 'Report', 'TOOL_END']);
    expect(html).toContain('src="data:audio/mpeg;base64,//uQZA=="');
  });

  test('associates group and item disclosure buttons with stable panels', () => {
    const entries = [
      tool('first', [{ type: 'content', content: { type: 'text', text: 'FIRST_OUTPUT' } }]),
      tool('second', [{ type: 'content', content: { type: 'text', text: 'SECOND_OUTPUT' } }]),
    ];
    const expanded = renderToStaticMarkup(<ToolCallGroup entries={entries} defaultExpanded />);
    const collapsed = renderToStaticMarkup(<ToolCallGroup entries={entries} />);
    const singleCollapsed = renderToStaticMarkup(<ToolCallGroup entries={[entries[0]]} />);

    const expandedControls = [...expanded.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1]);
    expect(expandedControls).toHaveLength(3);
    for (const panelId of expandedControls) expect(expanded).toContain(`id="${panelId}"`);
    expect(expanded.match(/aria-expanded="true"/g) ?? []).toHaveLength(3);

    const collapsedGroupPanel = collapsed.match(/aria-controls="([^"]+)"/)?.[1];
    expect(collapsedGroupPanel).toBeDefined();
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain(`id="${collapsedGroupPanel}"`);
    expect(collapsed).toContain('hidden=""');

    const collapsedItemPanel = singleCollapsed.match(/aria-controls="([^"]+)"/)?.[1];
    expect(collapsedItemPanel).toBeDefined();
    expect(singleCollapsed).toContain('aria-expanded="false"');
    expect(singleCollapsed).toContain(`id="${collapsedItemPanel}"`);
  });

  test('exposes every tool status as text without relying on symbols or color', () => {
    const statuses: ToolCallEntry['toolCall']['status'][] = [
      'queued',
      'in_progress',
      'waiting_for_confirmation',
      'completed',
      'rejected',
      'error',
      'cancelled',
    ];
    const entries = statuses.map(status => ({
      type: 'tool_call' as const,
      toolCall: {
        id: status,
        title: `Tool ${status}`,
        status,
        rawInput: { status },
      },
    }));
    const html = renderToStaticMarkup(<ToolCallGroup entries={entries} defaultExpanded />);

    for (const label of [
      'queued',
      'running',
      'waiting for confirmation',
      'completed',
      'rejected',
      'error',
      'cancelled',
    ]) {
      expect(html).toContain(`<span class="sr-only">${label}</span>`);
    }
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(statuses.length);
  });

  test('renders invalid audio MIME and base64 as inert unavailable content', () => {
    const html = renderToStaticMarkup(
      <ToolCallGroup
        entries={[
          tool('invalid-audio', [
            { type: 'content', content: { type: 'audio', mimeType: 'text/html', data: 'PHNjcmlwdD4=' } },
            { type: 'content', content: { type: 'audio', mimeType: 'audio/mpeg', data: 'bad base64!' } },
          ]),
        ]}
        defaultExpanded
      />,
    );

    expect((html.match(/Audio unavailable/g) ?? []).length).toBe(2);
    expectInOrder(html, ['text/html', 'audio/mpeg']);
    expect(html).not.toContain('src="data:');
    expect(html).not.toContain('PHNjcmlwdD4=');
  });

  test('treats an incomplete window implementation as no reduced-motion preference', () => {
    const globalWithWindow = globalThis as unknown as { window?: Window };
    const originalWindow = globalWithWindow.window;
    try {
      globalWithWindow.window = { location: { href: 'https://example.test' } } as unknown as Window;
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      if (originalWindow === undefined) Reflect.deleteProperty(globalWithWindow, 'window');
      else globalWithWindow.window = originalWindow;
    }
  });

  test('renders complete diff content', () => {
    const html = renderToStaticMarkup(
      <ToolCallGroup
        entries={[
          tool(
            'diff',
            [
              {
                type: 'diff',
                path: 'src/example.ts',
                oldText: 'BEFORE_VALUE',
                newText: 'AFTER_VALUE',
              },
            ],
            { patchId: 'PATCH_METADATA' },
          ),
        ]}
        defaultExpanded
      />,
    );

    expectInOrder(html, ['src/example.ts', 'BEFORE_VALUE', 'AFTER_VALUE', 'PATCH_METADATA']);
  });

  test('renders terminal identity and complete raw output', () => {
    const html = renderToStaticMarkup(
      <ToolCallGroup
        entries={[
          tool('terminal', [{ type: 'terminal', terminalId: 'terminal-42' }], { output: 'TERMINAL_RAW_OUTPUT' }),
        ]}
        defaultExpanded
      />,
    );

    expect(html).toContain('terminal-42');
    expect(html).toContain('TERMINAL_RAW_OUTPUT');
  });

  test('never truncates tool output at 2000 characters', () => {
    const tail = `HEAD_${'x'.repeat(2200)}_TAIL_SENTINEL`;
    const html = renderToStaticMarkup(
      <ToolCallGroup
        entries={[tool('long', [{ type: 'content', content: { type: 'text', text: tail } }])]}
        defaultExpanded
      />,
    );

    expect(html).toContain('TAIL_SENTINEL');
  });

  test('renders embedded text, image, and binary resources without dropping them', () => {
    const blocks: RenderableContentBlock[] = [
      {
        type: 'resource',
        resource: {
          uri: 'memory://notes.txt',
          mimeType: 'text/plain',
          text: 'EMBEDDED_TEXT',
        },
      },
      {
        type: 'resource',
        resource: {
          uri: 'memory://plot.png',
          mimeType: 'image/png',
          blob: 'aW1hZ2U=',
        },
      },
      {
        type: 'resource',
        resource: {
          uri: 'memory://archive.bin',
          mimeType: 'application/octet-stream',
          blob: 'YmluYXJ5',
        },
      },
    ];
    const html = renderToStaticMarkup(<ContentBlockView blocks={blocks} keyPrefix="embedded-test" mode="tool" />);

    expectInOrder(html, ['EMBEDDED_TEXT', 'Embedded image', 'archive.bin']);
    expect(html).toContain('application/octet-stream');
    expect(html).toContain('download="archive.bin"');
  });

  test('keeps malformed and non-http resource URIs inert', () => {
    const html = renderToStaticMarkup(
      <ContentBlockView
        blocks={[
          {
            type: 'resource_link',
            uri: 'javascript:alert(1)',
            name: 'unsafe-link',
          },
          {
            type: 'resource',
            resource: {
              uri: 'memory://bad%ZZ',
              mimeType: 'application/octet-stream',
              blob: 'YmluYXJ5',
            },
          },
        ]}
        keyPrefix="unsafe-test"
        mode="tool"
      />,
    );

    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('bad%ZZ');
  });

  test('shows lightweight sending and failed delivery states', () => {
    const entries: UserMessageEntry[] = [
      {
        type: 'user_message',
        id: 'sending',
        content: [{ type: 'text', text: 'one' }],
        deliveryState: 'sending',
      },
      {
        type: 'user_message',
        id: 'failed',
        content: [{ type: 'text', text: 'two' }],
        deliveryState: 'failed',
      },
    ];
    const html = renderToStaticMarkup(<ChatView entries={entries} phase="idle" activeAssistantId={null} />);

    expect(html).toContain('Sending');
    expect(html).toContain('Failed to send');
  });
});
