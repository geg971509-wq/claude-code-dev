# Remote Message Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ACP Direct and RCS preserve, aggregate, and render the official message content and streaming lifecycle through one shared thread state.

**Architecture:** A pure reducer owns message ordering, content accumulation, tool upserts, and turn lifecycle. ACP and RCS remain protocol adapters that emit reducer actions; the active `ChatView`, `MessageBubble`, and `ToolCallGroup` render the normalized state without reviving the deleted legacy renderer.

**Tech Stack:** TypeScript, React 19, Bun test, Hono, ACP WebSocket messages, RCS SSE, Streamdown, Tailwind CSS, Vite.

---

## File Responsibilities

- Create `packages/remote-control-server/web/src/lib/thread-state.ts`: normalized thread state, reducer actions, content-block conversion, status normalization, and immutable append/upsert helpers.
- Create `packages/remote-control-server/web/src/lib/acp-thread-events.ts`: translate ACP `SessionUpdate` values into shared reducer actions.
- Create `packages/remote-control-server/web/components/chat/ContentBlockView.tsx`: shared text/image/resource rendering used by user, assistant, and tool surfaces.
- Create `packages/remote-control-server/web/src/__tests__/thread-state.test.ts`: reducer, ACP mapping, and RCS mapping regression tests.
- Create `packages/remote-control-server/web/src/__tests__/message-renderers.test.tsx`: server-rendered content and active-stream-state regression tests.
- Modify `packages/remote-control-server/web/src/lib/types.ts`: replace split text/image message fields with normalized blocks and explicit entry/turn states.
- Modify `packages/remote-control-server/web/components/ChatInterface.tsx`: use `useReducer`, emit ACP actions, and make prompt completion authoritative.
- Modify `packages/remote-control-server/web/src/lib/rcs-chat-adapter.ts`: dispatch shared actions, consume raw stream events, reconcile final messages, and send image content blocks.
- Modify `packages/remote-control-server/web/src/pages/SessionDetail.tsx`: use shared thread state and remove entry-shape loading heuristics.
- Modify `packages/remote-control-server/web/components/chat/ChatView.tsx`: render active-entry streaming and phase-driven pre-response status.
- Modify `packages/remote-control-server/web/components/chat/MessageBubble.tsx`: render normalized blocks and Markdown thinking.
- Modify `packages/remote-control-server/web/components/chat/ToolCallGroup.tsx`: normalize official tool states and render content, diff, terminal, image, and resource data without destructive truncation.
- Modify `packages/remote-control-server/src/transport/ws-handler.ts`: preserve raw `partial_assistant.event` data.
- Modify `packages/remote-control-server/src/transport/client-payload.ts`: preserve array-valued user content through worker-compatible payloads.
- Modify `packages/remote-control-server/src/__tests__/ws-handler.test.ts`: prove raw stream events survive ingress.
- Modify `packages/remote-control-server/src/__tests__/client-payload.test.ts`: prove text/image arrays survive outbound conversion.

### Task 1: Shared Thread State

**Files:**
- Create: `packages/remote-control-server/web/src/lib/thread-state.ts`
- Modify: `packages/remote-control-server/web/src/lib/types.ts`
- Test: `packages/remote-control-server/web/src/__tests__/thread-state.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover these exact cases before implementation:

```ts
test('interleaved thinking and text deltas preserve chunk order', () => {
  const state = reduceThreadState(initialThreadState('s1'), [
    { type: 'turn_started', sessionId: 's1' },
    { type: 'assistant_thought_delta', sessionId: 's1', assistantId: 'a1', text: 'Inspecting' },
    {
      type: 'assistant_content',
      sessionId: 's1',
      assistantId: 'a1',
      block: { type: 'text', text: 'Done' },
    },
  ])

  expect(state.entries[0]).toMatchObject({
    type: 'assistant_message',
    id: 'a1',
    chunks: [
      { type: 'thought', text: 'Inspecting' },
      { type: 'message', content: [{ type: 'text', text: 'Done' }] },
    ],
    state: 'streaming',
  })
})

test('non-text content appends without losing source order', () => {
  const blocks = [
    { type: 'text', text: 'See ' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    { type: 'resource_link', uri: 'file:///tmp/a', name: 'a' },
  ] as const
  const state = blocks.reduce(
    (current, block) =>
      threadStateReducer(current, {
        type: 'assistant_content',
        sessionId: 's1',
        assistantId: 'a1',
        block,
      }),
    initialThreadState('s1'),
  )
  expect((state.entries[0] as AssistantMessageEntry).chunks[0]).toEqual({ type: 'message', content: blocks })
})

test('completed snapshot reconciles streamed content instead of duplicating it', () => {
  const streamed = threadStateReducer(initialThreadState('s1'), {
    type: 'assistant_content',
    sessionId: 's1',
    assistantId: 'a1',
    block: { type: 'text', text: 'Hello' },
  })
  const completed = threadStateReducer(streamed, {
    type: 'assistant_snapshot',
    sessionId: 's1',
    assistantId: 'a1',
    chunks: [{ type: 'message', content: [{ type: 'text', text: 'Hello' }] }],
  })
  expect(completed.entries).toHaveLength(1)
  expect(completed.entries[0]).toMatchObject({ state: 'completed' })
})

test('stale session actions are ignored', () => {
  const state = threadStateReducer(initialThreadState('s1'), {
    type: 'assistant_content',
    sessionId: 's2',
    assistantId: 'a2',
    block: { type: 'text', text: 'stale' },
  })
  expect(state.entries).toEqual([])
})
```

- [ ] **Step 2: Run the focused test and confirm the missing module/types fail**

Run:

```bash
bun test packages/remote-control-server/web/src/__tests__/thread-state.test.ts
```

Expected: nonzero exit because `thread-state.ts` and the normalized types do not yet exist.

- [ ] **Step 3: Define the normalized data model**

In `web/src/lib/types.ts`, use these contracts:

```ts
export type RenderableContentBlock = TextContent | ImageContent | ResourceLinkContent
export type AssistantChunk =
  | { type: 'message'; content: RenderableContentBlock[] }
  | { type: 'thought'; text: string; estimatedTokens?: number }

export type MessageDeliveryState = 'sending' | 'sent' | 'failed'
export type AssistantEntryState = 'streaming' | 'completed' | 'error' | 'cancelled'
export type ThreadPhase =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'using_tool'
  | 'cancelling'
  | 'error'

export interface UserMessageEntry {
  type: 'user_message'
  id: string
  content: RenderableContentBlock[]
  deliveryState: MessageDeliveryState
}

export interface AssistantMessageEntry {
  type: 'assistant_message'
  id: string
  chunks: AssistantChunk[]
  state: AssistantEntryState
}
```

Use the exact internal tool states `queued`, `in_progress`, `waiting_for_confirmation`, `completed`, `rejected`, `error`, and `cancelled`.

- [ ] **Step 4: Implement the pure reducer**

`thread-state.ts` must export:

```ts
export interface ThreadState {
  sessionId: string | null
  entries: ThreadEntry[]
  phase: ThreadPhase
  activeAssistantId: string | null
}

export function initialThreadState(sessionId: string | null = null): ThreadState
export function threadStateReducer(state: ThreadState, action: ThreadAction): ThreadState
export function reduceThreadState(state: ThreadState, actions: ThreadAction[]): ThreadState
export function normalizeToolStatus(status: string): ToolCallStatus
export function toRenderableContentBlock(block: ContentBlock): RenderableContentBlock | null
```

Merge only adjacent text blocks of the same assistant chunk. Append images and resources without reordering. Upsert tools by ID. Terminal actions must update only the active assistant entry and clear `activeAssistantId`.

- [ ] **Step 5: Run reducer tests and typecheck**

```bash
bun test packages/remote-control-server/web/src/__tests__/thread-state.test.ts
bun run --cwd packages/remote-control-server typecheck
```

Expected: all reducer tests pass and TypeScript reports zero errors after updating direct type consumers needed for compilation.

### Task 2: ACP Direct Integration

**Files:**
- Create: `packages/remote-control-server/web/src/lib/acp-thread-events.ts`
- Modify: `packages/remote-control-server/web/components/ChatInterface.tsx`
- Test: `packages/remote-control-server/web/src/__tests__/thread-state.test.ts`

- [ ] **Step 1: Add failing ACP mapping tests**

```ts
test('ACP assistant image and resource updates become content actions', () => {
  expect(
    acpUpdateToThreadActions('s1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    }),
  ).toEqual([
    {
      type: 'assistant_content',
      sessionId: 's1',
      assistantId: expect.any(String),
      block: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    },
  ])
})

test('ACP prompt completion is the normal terminal boundary', () => {
  const state = threadStateReducer(streamingState, {
    type: 'turn_completed',
    sessionId: 's1',
  })
  expect(state.phase).toBe('idle')
  expect(state.entries.at(-1)).toMatchObject({ state: 'completed' })
})
```

- [ ] **Step 2: Run the ACP mapping tests and confirm failure**

```bash
bun test packages/remote-control-server/web/src/__tests__/thread-state.test.ts -t ACP
```

Expected: nonzero exit because `acpUpdateToThreadActions` is not implemented.

- [ ] **Step 3: Implement the ACP adapter and switch `ChatInterface` to `useReducer`**

`acp-thread-events.ts` exports:

```ts
export function acpUpdateToThreadActions(
  sessionId: string,
  update: SessionUpdate,
): ThreadAction[]
```

Map `agent_message_chunk`, `agent_thought_chunk`, user content, tool upserts, and plans. `ChatInterface` dispatches these actions, dispatches `turn_started` before `sendPrompt`, and dispatches `turn_completed`, `turn_cancelled`, or `turn_failed` only from their real lifecycle callbacks.

Build the optimistic user entry from the same `ContentBlock[]` sent to `ACPClient.sendPrompt`. Mark it `failed` if image preparation or send fails; do not leave a false `sent` entry.

- [ ] **Step 4: Verify ACP behavior**

```bash
bun test packages/remote-control-server/web/src/__tests__/thread-state.test.ts
bun run --cwd packages/remote-control-server typecheck
```

Expected: ACP text, image, resource, thinking, tool, and terminal tests pass with zero type errors.

### Task 3: RCS Streaming and Image Wire Fidelity

**Files:**
- Modify: `packages/remote-control-server/src/transport/ws-handler.ts`
- Modify: `packages/remote-control-server/src/transport/client-payload.ts`
- Modify: `packages/remote-control-server/web/src/lib/rcs-chat-adapter.ts`
- Modify: `packages/remote-control-server/web/src/pages/SessionDetail.tsx`
- Test: `packages/remote-control-server/src/__tests__/ws-handler.test.ts`
- Test: `packages/remote-control-server/src/__tests__/client-payload.test.ts`
- Test: `packages/remote-control-server/web/src/__tests__/thread-state.test.ts`

- [ ] **Step 1: Add failing server transport tests**

```ts
test('preserves partial assistant raw stream events', () => {
  ingestBridgeMessage('s1', {
    type: 'partial_assistant',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Inspecting' },
    },
    uuid: 'a1',
  })
  expect(events[0]).toMatchObject({
    type: 'partial_assistant',
    payload: { event: { type: 'content_block_delta' }, uuid: 'a1' },
  })
})

test('preserves image blocks in user content', () => {
  const content = [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]
  expect(toClientPayload(userEvent({ message: { content } }))).toMatchObject({
    message: { content },
  })
})
```

- [ ] **Step 2: Run server tests and confirm both failures**

```bash
bun test packages/remote-control-server/src/__tests__/ws-handler.test.ts packages/remote-control-server/src/__tests__/client-payload.test.ts
```

Expected: nonzero exit because partial events and array-valued content are currently discarded.

- [ ] **Step 3: Preserve protocol payloads at the server boundary**

For `partial_assistant`, publish:

```ts
payload = { event: msg.event, uuid: msg.uuid }
```

For outbound user conversion, select content in this order:

```text
raw.message.content -> normalized.message.content -> normalized.content -> empty string
```

Do not flatten an array into display text on the worker-facing path.

- [ ] **Step 4: Add failing RCS reducer tests**

Cover `message_start`, indexed content-block starts, text/thinking deltas, streaming tool JSON, message stop, final snapshot reconciliation, history parity, result completion, cancellation, error, and unknown-delta tolerance.

- [ ] **Step 5: Rework `RCSChatAdapter` into a protocol adapter**

Keep only protocol state that cannot live in the reducer: content-block kind by stream index and partial tool JSON buffers. Dispatch reducer actions for every semantic update.

Build the RCS user payload as:

```ts
const content = [
  ...(text ? [{ type: 'text' as const, text }] : []),
  ...images.map(image => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: image.mimeType,
      data: image.data,
    },
  })),
]

await apiSendEvent(sessionId, {
  type: 'user',
  uuid,
  content: text,
  message: { role: 'user', content },
})
```

Accept image-only prompts. Use the reducer for optimistic delivery, failure, history replacement, and terminal lifecycle.

- [ ] **Step 6: Remove `SessionDetail` loading heuristics**

Render from `ThreadState.phase`. Do not set loading false when an assistant or tool entry first appears. Completion comes from `message_stop`, `result`, `result_success`, session terminal status, error, or interrupt.

- [ ] **Step 7: Verify RCS transport and reducer behavior**

```bash
bun test packages/remote-control-server/src/__tests__/ws-handler.test.ts packages/remote-control-server/src/__tests__/client-payload.test.ts
bun test packages/remote-control-server/web/src/__tests__/thread-state.test.ts
```

Expected: all server and web state tests pass.

### Task 4: Complete Active Rendering

**Files:**
- Create: `packages/remote-control-server/web/components/chat/ContentBlockView.tsx`
- Modify: `packages/remote-control-server/web/components/chat/ChatView.tsx`
- Modify: `packages/remote-control-server/web/components/chat/MessageBubble.tsx`
- Modify: `packages/remote-control-server/web/components/chat/ToolCallGroup.tsx`
- Test: `packages/remote-control-server/web/src/__tests__/message-renderers.test.tsx`

- [ ] **Step 1: Add failing renderer tests with `react-dom/server`**

```tsx
test('assistant renders Markdown thinking, image, and resource content', () => {
  const html = renderToStaticMarkup(
    <AssistantBubble
      entry={assistantEntry({
        state: 'completed',
        chunks: [
          { type: 'thought', text: '**Checked** the image' },
          {
            type: 'message',
            content: [
              { type: 'image', mimeType: 'image/png', data: 'AAAA' },
              { type: 'resource_link', uri: 'file:///tmp/report', name: 'report' },
            ],
          },
        ],
      })}
      isStreaming={false}
    />,
  )
  expect(html).toContain('<strong>Checked</strong>')
  expect(html).toContain('data:image/png;base64,AAAA')
  expect(html).toContain('report')
})

test('only the active assistant receives streaming presentation', () => {
  const html = renderToStaticMarkup(
    <ChatView entries={[completedAssistant, streamingAssistant]} phase="responding" activeAssistantId="a2" />,
  )
  expect(count(html, 'data-streaming="true"')).toBe(1)
})
```

Add tool fixtures for text, diff, terminal, image, and resource content. Assert the full tail of content beyond 2,000 characters remains in rendered output.

- [ ] **Step 2: Run renderer tests and confirm failure**

```bash
bun test packages/remote-control-server/web/src/__tests__/message-renderers.test.tsx
```

Expected: nonzero exit because normalized block rendering and per-entry streaming are not implemented.

- [ ] **Step 3: Implement shared content rendering**

`ContentBlockView` renders:

- text through `MessageResponse` in message mode and preserved whitespace in plain/tool mode;
- images as accessible thumbnail buttons with safe data URLs and full-size preview;
- resources as external/file links with name, optional description, MIME type, and size.

Use Lucide icons already installed. Keep the existing user alignment, assistant avatar, spacing, color tokens, and permission controls.

- [ ] **Step 4: Make streaming presentation entry-specific**

Change `ChatView` props to:

```ts
interface ChatViewProps {
  entries: ThreadEntry[]
  phase: ThreadPhase
  activeAssistantId: string | null
  onPermissionRespond?: PermissionResponder
  emptyTitle?: string
  emptyDescription?: string
}
```

Pass `isStreaming` only when the rendered entry ID matches `activeAssistantId`. Show the pre-response indicator only for `requesting` without an active assistant.

- [ ] **Step 5: Complete thinking and tool rendering**

Render thought text through `MessageResponse` inside the existing `Reasoning` shell. Render tool diff as old/new code sections, terminal content as a terminal reference row, and nested content blocks through `ContentBlockView`. Replace string slicing with the existing collapsed/scrollable container so complete output remains available.

- [ ] **Step 6: Verify rendering, typecheck, and production build**

```bash
bun test packages/remote-control-server/web/src/__tests__/message-renderers.test.tsx
bun run --cwd packages/remote-control-server typecheck
bun run --cwd packages/remote-control-server build:web
```

Expected: renderer tests pass, typecheck reports zero errors, and Vite produces the production bundle.

### Task 5: Integration and Release Verification

**Files:**
- Modify only test or implementation files required by failing checks from Tasks 1-4.
- Update `GATES.md` evidence through the Unlazy checker.

- [ ] **Step 1: Run all focused checks**

```bash
bun test packages/remote-control-server/web/src/__tests__/thread-state.test.ts packages/remote-control-server/web/src/__tests__/message-renderers.test.tsx
bun test packages/remote-control-server/src/__tests__/ws-handler.test.ts packages/remote-control-server/src/__tests__/client-payload.test.ts
bun run --cwd packages/remote-control-server typecheck
bun run --cwd packages/remote-control-server build:web
bun test packages/remote-control-server
bun test scripts/__tests__/knip-config.test.ts
```

Expected: every command exits zero.

- [ ] **Step 2: Run browser smoke checks**

Start the RCS server and web dev server, then validate desktop and mobile widths with fixtures containing:

- image-only user input;
- assistant text plus image and resource link;
- expanded and completed thinking;
- requesting and responding states;
- tool text, diff, terminal, image, resource, error, rejection, and cancellation.

Record screenshots and verify no blank content, overlap, clipped controls, or layout shift.

- [ ] **Step 3: Run the full repository gate**

```bash
bun run precheck
```

Expected: typecheck, Biome, dependency boundaries, and all repository tests pass.

- [ ] **Step 4: Re-run Knip and inspect only newly introduced findings**

```bash
bun run check:unused
```

Expected: the command may remain nonzero for the existing candidate backlog, but none of the files or exports introduced by this feature appear as new unused candidates.

- [ ] **Step 5: Verify and record the acceptance gates**

After reviewing every `CHECK:` command in `GATES.md`:

```bash
node /Users/king/.codex/skills/unlazy/scripts/gate-check.mjs --approve GATES.md
node /Users/king/.codex/skills/unlazy/scripts/gate-check.mjs --reverify GATES.md
```

Expected: runnable gates G0-G6 are met. Record desktop/mobile screenshot evidence for manual gate G7.

- [ ] **Step 6: Commit only feature-owned files**

Use Conventional Commits and do not stage unrelated dirty-worktree changes:

```bash
git add packages/remote-control-server/src/transport/ws-handler.ts \
  packages/remote-control-server/src/transport/client-payload.ts \
  packages/remote-control-server/src/__tests__/ws-handler.test.ts \
  packages/remote-control-server/src/__tests__/client-payload.test.ts \
  packages/remote-control-server/web/src/lib/types.ts \
  packages/remote-control-server/web/src/lib/thread-state.ts \
  packages/remote-control-server/web/src/lib/acp-thread-events.ts \
  packages/remote-control-server/web/src/lib/rcs-chat-adapter.ts \
  packages/remote-control-server/web/src/pages/SessionDetail.tsx \
  packages/remote-control-server/web/components/ChatInterface.tsx \
  packages/remote-control-server/web/components/chat/ContentBlockView.tsx \
  packages/remote-control-server/web/components/chat/ChatView.tsx \
  packages/remote-control-server/web/components/chat/MessageBubble.tsx \
  packages/remote-control-server/web/components/chat/ToolCallGroup.tsx \
  packages/remote-control-server/web/src/__tests__/thread-state.test.ts \
  packages/remote-control-server/web/src/__tests__/message-renderers.test.tsx
git commit -m "feat: 对齐远程消息流式与多模态能力"
```

If any listed file contains unrelated pre-existing edits, inspect and stage only the feature hunks rather than committing another owner's work.
