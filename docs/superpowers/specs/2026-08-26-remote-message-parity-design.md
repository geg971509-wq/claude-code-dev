# Remote Message Parity Design

## Status

Approved direction: shared message aggregation for ACP Direct and RCS.

## Goal

Align the active remote-control web chat with the official message pipeline for images, thinking content, streaming state, tool progress, Markdown/code rendering, and current visual styling.

The active path remains:

```text
ACPClient / RCS events
  -> protocol adapter
  -> shared thread reducer
  -> ChatView
  -> MessageBubble / ToolCallGroup
```

The deleted `ChatMessage.tsx` stays deleted. It supported less content and would recreate a second renderer.

## Current Gaps

1. ACP session updates discard assistant images and resource links because only text blocks are accepted.
2. RCS sends images into local UI state but omits them from the wire payload.
3. RCS drops `partial_assistant` stream events, while the official pipeline consumes raw content-block deltas.
4. A global loading boolean marks historical assistant entries as streaming.
5. RCS ends loading when the first assistant/tool entry appears instead of at a terminal turn event.
6. Tool rendering discards diff, terminal, image, and resource-link content and truncates structured output data.
7. Thinking content is rendered as plain text instead of Markdown.
8. The active message pipeline has no focused reducer or renderer regression tests.

## Architecture

### Shared Thread State

Add one pure reducer under `packages/remote-control-server/web/src/lib/` and use it from both `ChatInterface` and `RCSChatAdapter`.

The reducer owns:

- ordered message and tool entries;
- adjacent text/thinking delta accumulation;
- assistant snapshot reconciliation after streamed deltas;
- tool-call upsert by stable tool-call ID;
- active assistant ID and per-entry completion state;
- the turn phase: `idle`, `requesting`, `thinking`, `responding`, `using_tool`, `cancelling`, or `error`;
- terminal transitions for completion, cancellation, and failure.

Protocol-specific modules only translate their input into reducer actions. They do not implement their own append/upsert logic.

### Content Model

Use one renderable content-block union for both user and assistant messages:

```ts
type RenderableContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | {
      type: 'resource_link'
      uri: string
      name: string
      title?: string
      description?: string
      mimeType?: string
      size?: number
    }
```

Assistant chunks retain their semantic boundary:

```ts
type AssistantChunk =
  | { type: 'message'; content: RenderableContentBlock[] }
  | { type: 'thought'; text: string; estimatedTokens?: number }
```

Unknown content blocks are ignored without crashing. The original payload remains available at the protocol boundary for diagnostics.

Tool status uses explicit internal semantics:

```text
queued -> in_progress -> completed
                   \-> waiting_for_confirmation
                   \-> rejected | error | cancelled
```

External aliases such as `pending`, `running`, `complete`, `failed`, and `result` are normalized once at the boundary.

### ACP Direct Mapping

`agent_message_chunk` accepts text, image, and resource-link blocks. Consecutive text deltas merge; non-text blocks append in arrival order.

`agent_thought_chunk` accumulates thinking text and moves the turn to `thinking`. The following message or tool update moves it to the corresponding phase.

`tool_call` and `tool_call_update` share the reducer's tool upsert path. `prompt_complete` is the only normal completion boundary. Cancellation and errors use explicit terminal actions.

### RCS Mapping

The server preserves the raw `event` payload of `partial_assistant` instead of treating it as a completed assistant message.

The web adapter consumes official-style stream events:

- `message_start` starts or identifies the active assistant message;
- `content_block_start` records the block type and index;
- `text_delta` and `thinking_delta` append to the matching chunk;
- `input_json_delta` accumulates streaming tool input;
- `content_block_stop` closes the current block;
- `message_delta` records stop and usage metadata when present;
- `message_stop`, `result`, `result_success`, error, or cancellation closes the turn.

The later completed `assistant` event reconciles the streamed message by ID/content instead of duplicating it.

Historical events go through the same content and tool normalization as live events, with every entry marked complete.

### Image Wire Contract

ACP Direct keeps its existing ACP image block:

```ts
{ type: 'image', mimeType, data }
```

RCS sends the official Anthropic user-content shape through `message.content`:

```ts
{
  type: 'image',
  source: { type: 'base64', media_type: mimeType, data }
}
```

Text remains a normal `{ type: 'text', text }` block. Image-only prompts are valid. The server transport must preserve an array-valued `message.content` all the way to the bridge client.

### Rendering

Keep the current visual system and active components.

- `UserBubble` renders text, images, and resource links in source order while preserving the existing right-aligned style and long-text expansion.
- `AssistantBubble` renders Markdown/code, image previews, resource links, and Markdown thinking content.
- Only the active assistant entry receives streaming presentation.
- The pre-response indicator is driven by `requesting`, not by the shape of the last entry.
- `Reasoning` auto-opens while thinking is active and collapses only when that thought completes.
- `ToolCallGroup` renders text, diff, terminal reference, image, and resource-link blocks by type.
- Tool output stays fully available behind the existing expansion/scroll UI; it is not destructively truncated to 2,000 characters.
- Existing permission controls and plan rendering remain unchanged.

## Error Handling

- Invalid base64 or unsupported image MIME types produce a visible send error and do not create a false local success message.
- Unknown stream deltas and unknown content blocks do not terminate the session.
- A failed send rolls back the optimistic user entry or marks it failed; it cannot remain indistinguishable from a delivered message.
- A terminal error closes streaming state and preserves the partial content already received.
- Session switches discard stale updates by session ID.

## Tests

Add focused tests without new dependencies:

1. Pure reducer tests for interleaved thinking/text deltas, content-block ordering, final snapshot reconciliation, tool upserts, terminal states, and stale-session rejection.
2. ACP mapping tests for text, assistant image/resource blocks, image-only user updates, tool content, and prompt completion.
3. RCS server/transport tests proving `partial_assistant.event` and array-valued image content survive the wire path.
4. RCS history/live mapping tests proving identical events produce identical thread entries.
5. Renderer tests for user/assistant images, Markdown thinking, resource links, structured tool content, and active-entry-only streaming.
6. Existing RCS typecheck, production web build, package tests, Knip configuration tests, and full repository `precheck`.
7. Browser smoke checks at desktop and mobile widths for image overflow, thinking expansion, streaming indicators, tool details, and text overlap.

## Non-Goals

- No new renderer or compatibility copy of `ChatMessage.tsx`.
- No new dependency.
- No visual redesign outside the active message surfaces.
- No unrelated session-history/sidebar cleanup in this change.
- No protocol schema version field; compatibility remains shape-detected.

## Acceptance Criteria

1. Equivalent ACP Direct and RCS inputs produce equivalent `ThreadState` output.
2. Text, image, resource, thinking, tool, and plan content are not silently discarded.
3. Image-only prompts reach the agent in both paths.
4. Streaming state belongs only to the active turn and ends only on an explicit terminal event.
5. Final assistant snapshots do not duplicate streamed content.
6. Tool status and structured content remain visible and correctly associated by tool-call ID.
7. Current visual styling, permission actions, and plan display remain intact.
8. Targeted checks and full `bun run precheck` pass.
