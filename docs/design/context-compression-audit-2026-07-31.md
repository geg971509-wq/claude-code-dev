# Context Compression Logic Audit Report

**Date**: 2026-07-31 (findings verified against source 2026-07-31)  
**Fact-check**: 2026-08-03 — see plan `docs/design/context-compression-fix-plan-2026-08-03.md`  
**Branch**: `fix/stream-lifecycle-hardening`  
**Issue**: Context compression takes too long  
**Reference**: kimi-code implementation at `/Volumes/work/software/install/kimi-code`

### 2026-08-03 errata (post fact-check + fix plan)

- §0 env snapshot (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80`) was **audit-environment local**, not a repo default. Override is now surfaced at startup stderr + `/status` when active.
- Predictive autocompact path in `query.ts` **removed** (dead outer gate / same-turn double-fire on failure). Mentions of “predictive compact” below are historical unless noted.
- Two §1 overstatements corrected in place (same-iteration wording; “content always grows”).
- Floor budgets unchanged; measure via existing `logEvent` fields only if a local sink is on — this fork’s 1P `tengu_*` export is hard-off.

---

## Audit Outcome

The original report claimed 3 logic issues. Each was checked against source.

| # | Claim | Verdict | Action |
|---|-------|---------|--------|
| 1 | Missing `lastCompactedTokenCount` retrigger guard | Mechanism confirmed; causal claim and proposed fix **rejected** | None — see §1 |
| 2 | Fork path summarizes the preserved tail | **Confirmed** | **Fixed** in `compact.ts` |
| 3 | `COMPACT_TOOL_RESULT_MAX_CHARS = 2_000` too low | Constant confirmed; "too low" **unverified** | None — see §3 |
| — | *(not in original report)* trigger lowered 14% by a test env var | **Found during audit** | Environment fix — see §0 |

Issue 2's implementation plan has been removed from this document because it landed.
Issues 1 and 3 are retained with corrected findings so the rejections are not re-litigated
from the original (partly wrong) analysis.

The report's stated motivation — "context compression takes too long" — is separately
addressed in §0, which none of the three issues covered.

---

## §0 Check this before any code change: the trigger point may be hand-lowered

Found while verifying §1's threshold math. The audit environment has:

```
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
```

`getAutoCompactThreshold` (`autoCompact.ts:101–120`) applies it as
`min(floor(effectiveWindow × pct/100), autocompactThreshold)`. For a 200k model that is
`min(144 000, 167 000)` = **144 000** — autocompact fires 23 000 tokens (14%) earlier than
the default, so compaction runs **more often** for the same workload.

The comment above it reads `// Override for easier testing of autocompact` — a test knob. It
is clamped by `min(...)`, so it can only ever lower the trigger, never raise it. It is read
in exactly one place in the entire tree (`autoCompact.ts:108`) and, before this document, was
mentioned in no docs.

Its effect does reach the UI, but its cause is never named: `getAutoCompactThreshold` feeds
`calculateTokenWarningState`, so the override also shifts `percentLeft` and the
warning/error thresholds (threshold − 20 000 each). The status bar therefore reports less
headroom than the model actually has, with nothing indicating why.

This is a more plausible cause of "compression takes too long" than any of the three reported
issues, and the remedy is one `unset`. It also reframes Issue 1: the report diagnosed a
missing retrigger guard while the trigger point itself had been hand-lowered by 14% — the
symptom it set out to explain (compaction firing more than expected) has a mundane
environmental cause that no amount of guard logic would fix.

**Before acting on §1 or §3, verify the threshold in the affected environment:**

```bash
env | grep CLAUDE_AUTOCOMPACT_PCT_OVERRIDE   # expect no output
```

If it is set, unset it and re-measure before concluding anything about compaction frequency.

---

## §1 Issue 1: Retrigger Guard — mechanism real, proposed fix rejected

### Verified as stated

- No retrigger guard exists anywhere in the autocompact path. `AutoCompactTrackingState`
  (`autoCompact.ts:51–60`) carries only `compacted` / `turnCounter` / `turnId` /
  `consecutiveFailures`. `shouldAutoCompact` (`autoCompact.ts:189–266`) takes 4 params and
  returns `isAboveAutoCompactThreshold` with no baseline comparison.
- `truePostCompactTokenCount` is computed in `compact.ts`, returned on `CompactionResult`,
  logged at `query.ts:697,710`, and never read for suppression. `willRetriggerNextTurn` is
  detection-only telemetry.
- The kimi-code citations are accurate: field declared `full.ts:85`, guard `full.ts:291–292`,
  set at `full.ts:357` and `full.ts:647`, reset in `resetForTurn()` `full.ts:248–252`.

### Why the proposed fix was rejected: unit mismatch

kimi-code reads and writes the guard through a **single accessor**
(`tokenCountWithPending`, `full.ts:234–236`), so both sides are the same unit by
construction — and that unit **includes system prompt + tools**
(`estimateRequestTokens`, `full.ts:238–245`).

The proposed `Option A` would have compared two different units:

- `shouldAutoCompact` measures `tokenCountWithEstimation(messages)` — the last API
  response's **full** usage (input + cache_creation + cache_read + output, which already
  contains system prompt and tools) plus a rough estimate of messages added since
  (`tokens.ts:251–292`).
- `truePostCompactTokenCount` is `roughTokenCountEstimationForMessages(...)` over the
  **message payload only**. `compact.ts` says so in place: the next iteration's
  `shouldAutoCompact` "will see this PLUS ~20-40K for system prompt + tools + userContext".

So `currentCount <= lastCompactedTokenCount` would put a system+tools-inclusive number on
the left and a payload-only number on the right. Once any API response has landed on the
post-compact chain, the left side is inflated by that overhead and the guard **cannot
fire** — a no-op in exactly the scenario the report set out to fix. The one window where
the two *are* comparable is before the first post-compact API response, i.e. the predictive
check at `query.ts:875` — where firing would suppress a wanted compact.

The report's "**Tradeoffs**: None" is therefore false in both directions: no-op where it
was aimed, over-suppression where it would actually trigger.

### The retrigger case the report describes is already mitigated

Two mechanisms the original report did not account for:

1. **Stale-usage stripping.** `stripToolUseResults` (`compact.ts:357–386`) strips API usage
   from preserved assistant messages, with this rationale in the source:

   > that usage describes the PRE-compact context (≈ the over-threshold count that
   > triggered compaction). If it survived, `tokenCountWithEstimation` would report the
   > stale pre-compact count on the new chain and immediately retrigger compaction
   > (same-turn predictive check, next-turn auto check, status bar warning).

   That is the immediate-retrigger failure mode, already closed.

2. **Same-iteration proactive path.** After a **successful** proactive compact,
   `compactionResult` is set and the blocking-limit check is skipped (`!compactionResult`
   in `query.ts`). Historically a second **predictive** `deps.autocompact` also sat behind
   that gate and could still run after a **failed** main attempt; that predictive block was
   removed 2026-08-03. Reactive compact (413 recovery) is a later path and is not gated by
   the pre-stream `compactionResult` flag.

Later iterations **usually** grow once an assistant turn + tool results land; snip /
microcompact / collapse can shrink payload, so a floor-style `current <= last` guard is still
the wrong first fix. kimi-code's guard is **within-turn only** — `resetForTurn()` nulls the
field at every turn start — closer to “don’t compact twice after success in one turn” than
to a cross-turn suppress.

### If the slowness is real, measure this first

Fields `truePostCompactTokenCount` and `willRetriggerNextTurn` are computed on
`tengu_compact` / `tengu_auto_compact_succeeded`. **On this fork, 1P `tengu_*` export is
hard-off** — do not assume BQ. Use local debug / optional Datadog if configured. If
`willRetriggerNextTurn` is frequently true, the post-compact floor genuinely sits above the
threshold, and the fix is to **lower the floor** (post-compact attachment restore,
`messagesToKeep` budget, preserved-user-message budget) — not to suppress the trigger.
Suppression in that state would let context grow unchecked until the API rejects the
request, converting a slow session into a broken one. **No floor budget change without that
measurement** (plan 5A).

The threshold math, for reference: `getEffectiveContextWindowSize` = window −
min(maxOutputTokens, 20 000); `getAutoCompactThreshold` = that − buffer, where the buffer is
50 000 (≥800k window) / 30 000 (≥400k) / 13 000 otherwise. For a 200k window: 180 000
effective, 167 000 trigger — **assuming no `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`**. That env var
takes `min(floor(effective × pct/100), threshold)`, so it can only lower the trigger.
When set, startup stderr and `/status` now name it (see `getAutocompactPctOverride`).

---

## §3 Issue 3: Tool-result truncation threshold — confirmed value, unverified judgment

### Verified as stated

`COMPACT_TOOL_RESULT_MAX_CHARS = 2_000` at `toolResultTruncation.ts:3`, applied only on the
streaming fallback path (`compact.ts`, `truncateToolResultsForCompaction(messages)`), never
on the fork path.

### Why it was not changed

"Too low" is a quality judgment, not a defect, and the module documents a second purpose the
report omitted:

> On the fallback path (3P providers, cache-sharing disabled/failed) there is no cache to
> reuse, so truncation is a pure win and also **lowers the chance the compact request itself
> hits prompt-too-long**.

The fallback path runs precisely when context is largest. Raising the cap 5× increases the
chance the compact request hits prompt-too-long, which costs a PTL retry round-trip — the
same latency this audit was opened to reduce. Trading a latency win for a latency risk needs
a measurement, not an estimate.

The report's adaptive-truncation snippet is also not implementable as written: it reads
`b.content?.length`, but `tool_result` content is either a string **or** an array of
`{ type: 'text' }` blocks (`toolResultTruncation.ts:67–90`).

Revisit only with a measured summary-quality regression, paired with a PTL-rate check on the
fallback path.

---

## Comparison vs kimi-code

Rows below were re-checked against both codebases.

| Aspect | Current | kimi-code | Assessment |
|--------|---------|-----------|------------|
| **Retrigger guard** | None | `lastCompactedTokenCount`, within-turn only | Absent, but not the cause — see §1 |
| **Tail preservation** | Whole API rounds kept verbatim | Only user messages kept; assistant/tool dropped | Different design (from opencode) |
| **Summary placement** | Embedded in text with `<preserved-user-messages>` | Separate last message | Both valid |
| **Summarizer input** | Head-only on both fork and fallback | Full `originalHistory` | Fixed — was fork-only divergence |
| **Tool truncation** | 2 000 chars, fallback only | None | Deliberate PTL trade — see §3 |
| **Elision marker** | Embedded in summary text | Separate injection message | Both valid |
| **Token estimation** | ~4 chars/token ASCII, 1 char/token non-ASCII | Same | Same |
| **Budget for user msgs** | 20k tokens | 20k tokens | Same |

**Key insight**: tail preservation is a deliberate enhancement over kimi-code (borrowed from
opencode). The bug was never that it exists — it was that one of the two summarizer paths
ignored it.

---

## References

- **Branch**: `fix/stream-lifecycle-hardening` (audit opened at `67bc750d`)
- **kimi-code**: `/Volumes/work/software/install/kimi-code`
- **Files audited**: `src/services/compact/{compact.ts,autoCompact.ts,tailPreservation.ts,`
  `preservedUserMessages.ts,toolResultTruncation.ts,prompt.ts}`, `src/query.ts`,
  `src/utils/tokens.ts`
- **kimi-code guard**: `packages/agent-core/src/agent/compaction/full.ts:85,234–245,248–252,291–292,357,647`
