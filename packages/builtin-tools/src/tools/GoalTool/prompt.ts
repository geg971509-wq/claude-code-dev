export const DESCRIPTION =
  'Get or update the active goal status. The model may only mark a goal as "complete" or "blocked". Natural language claims do not end the goal.'

export function generatePrompt(): string {
  return `Use this tool to interact with the active thread goal.

## Actions

### get
Returns the current goal state (objective, status, token usage, elapsed time, turns executed).
No input required beyond \`action: "get"\`.

### update
Transition the goal to a terminal status. Only two values are accepted:
- **complete** — All requirements are verified (see Completion Audit below). The goal is cleared after this call; write a short final summary for the user using the outcome prompt in the tool result.
- **blocked** — An insurmountable obstacle has persisted for 3+ consecutive turns (see Blocked Audit), OR set \`immediate: true\` when the objective itself is impossible, unsafe, or contradictory.

When marking complete, provide a brief \`reason\` summarising what was achieved.
When marking blocked, provide a \`reason\` describing the specific blocker.

## Completion Audit (required before marking complete)
1. Derive concrete requirements from the objective.
2. Preserve the original scope — do not redefine success around existing work.
3. For every requirement, identify authoritative evidence (test output, file content, command result).
4. Treat tests and manifests as evidence only after confirming they cover the requirement.
5. Treat uncertain or indirect evidence as "not achieved".
6. The audit must PROVE completion, not merely fail to find remaining work.
7. Do not mark complete after only a plan, summary, first pass, or partial result.

## Blocked Audit (required before marking blocked)
1. The same blocking condition must persist across at least 3 consecutive continuation turns (unless \`immediate: true\`).
2. "Difficult", "slow", or "partially incomplete" is NOT blocked.
3. Only genuinely insurmountable obstacles qualify (missing credentials, external service down, etc.).
4. Use \`immediate: true\` only for impossible / unsafe / contradictory objectives.

## Important
- You cannot pause, resume, or clear a goal — only the user can do that via \`/goal\`.
- Natural language "I'm done" / "blocked" does **not** end the goal — only this tool does.
- If no goal is active, \`get\` returns a message saying so; \`update\` returns an error.
- On completion, the tool result includes a usage report and an outcome prompt for your final user message.
- On blocked (after 3 strikes or immediate), the tool result includes an outcome prompt for your final user message.`
}
