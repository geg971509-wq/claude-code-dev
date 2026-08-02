# Context Compression Fix Plan (2026-08-03)

**Branch**: `fix/stream-lifecycle-hardening`  
**Source decisions** (user, sequential): `1A 2A 3A 4A 5A`  
**Upstream audit**: `docs/design/context-compression-audit-2026-07-31.md` (fact-checked 2026-08-03)  
**Constraint**: shortest working diff; no speculative redesign; no new feature flags; no new abstractions unless a second call site already exists.

---

## 0. Goal & non-goals

### Goal

Ship the five decided items:

| ID | Decision | Outcome |
|----|----------|---------|
| **1A** | Delete predictive autocompact block | Remove dead / double-fire path in `query.ts` |
| **2A** | Vanish with 1A | No separate yield/tracking fix |
| **3A** | Correct audit doc wording + line anchors | Fix two overstatements; refresh symbols/lines |
| **4A** | Warn when `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is active | Startup + `/status` (Status tab) surface it |
| **5A** | Measure before changing post-compact floor | Document observation only; **no floor code change** |

### Non-goals

- Do **not** implement kimi-style `lastCompactedTokenCount` retrigger guard.
- Do **not** raise/lower `COMPACT_TOOL_RESULT_MAX_CHARS`, tail budget, or preserved-user budget.
- Do **not** rewrite reactive compact, snip, microcompact, or session-memory compact.
- Do **not** add config UI toggles, GrowthBook gates, or new env vars.
- Do **not** “improve” predictive into a real preemptive compact (rejected as 1C).

---

## 1. Evidence (facts this plan rests on)

Verified against source on 2026-08-03:

1. **Predictive block is effectively dead or harmful** (`src/query.ts` ~871–911):
   - Outer gate: `!compactionResult && isAutoCompactEnabled()`.
   - Outer threshold: `effectiveWindow - estimateMaxTurnGrowth(model)` (~−35k headroom).
   - Inner call: same `deps.autocompact` → `shouldAutoCompact` uses **stricter** threshold (`effective − 13k/30k/50k`).
   - Therefore: tokens high enough for outer gate but under inner threshold → no compact; under outer gate → skip; **main path already compacted** → skip; **main path failed** → predictive retries same turn → **double API cost**.
2. **`estimateMaxTurnGrowth` / `TOOL_RESULT_GROWTH_ESTIMATE`** are only referenced from that predictive block + their definition in `autoCompact.ts`. After 1A they become dead exports/consts → delete with the call site.
3. **`getEffectiveContextWindowSize` import in `query.ts`** is only used by the predictive block (blocking-limit path uses `calculateTokenWarningState` only). After 1A, drop that import if unused.
4. **Audit doc overstatements** (`docs/design/context-compression-audit-2026-07-31.md` §1):
   - “second compact cannot fire in the same query-loop iteration” — false on main-path **failure** while predictive existed; after 1A becomes true for proactive path, but wording should describe the actual gate (`!compactionResult` after **success** only historically mattered with predictive).
   - “Across iterations, content always grows” — overstated (snip/microcompact/collapse can shrink).
5. **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`**: single read in `getAutoCompactThreshold` (`autoCompact.ts`); `Math.min` → can only **lower** threshold; feeds `calculateTokenWarningState` → status-bar headroom shifts with **no UI name for the cause**.
6. **Post-compact floor**: `willRetriggerNextTurn` + `truePostCompactTokenCount` already logged on `tengu_compact`; no code change until data says floor ≥ threshold often.

---

## 2. Work items (executable)

### WI-1 — Delete predictive autocompact (1A / 2A)

**File**: `src/query.ts`

**Do**:

1. Delete the entire block from the comment `// Predictive autocompact:` through the closing `}` of that `if (!compactionResult && isAutoCompactEnabled())` (currently ~871–911).
2. Remove now-unused imports:
   - `estimateMaxTurnGrowth` from `./services/compact/autoCompact.js`
   - `getEffectiveContextWindowSize` from `./services/compact/effectiveWindow.js` **only if** no other use remains in `query.ts` (expected: none).
3. Keep: main `deps.autocompact` call, blocking-limit check, reactive compact, collapse paths, `!compactionResult` gates that remain relevant for blocking-limit skip-after-success.

**Do not**:

- Touch tracking reset on the **main** success path (already correct).
- Introduce `applyCompactionResult` helper (2B rejected).

**File**: `src/services/compact/autoCompact.ts`

**Do**:

1. Delete `TOOL_RESULT_GROWTH_ESTIMATE` constant.
2. Delete `estimateMaxTurnGrowth` function and its JSDoc.
3. Leave `getAutocompactBufferTokens`, `getAutoCompactThreshold`, circuit breaker, etc. unchanged (except WI-4 helpers if colocated).

**Tests**:

- Grep after edit: zero references to `estimateMaxTurnGrowth` / `TOOL_RESULT_GROWTH_ESTIMATE` outside deleted code.
- If any test asserted predictive behavior (unlikely — none found at plan time), delete or rewrite that assertion. Expected: no dedicated test file.
- Run targeted: `bun test src/services/compact` and any `query` tests if present; full gate later via `bun run precheck`.

**Acceptance**:

- [ ] Predictive block gone from `query.ts`.
- [ ] No unused imports left in `query.ts` from this change.
- [ ] Dead export/const removed from `autoCompact.ts`.
- [ ] Main autocompact + reactive compact still compile and existing tests pass.

---

### WI-2 — Correct audit document (3A)

**File**: `docs/design/context-compression-audit-2026-07-31.md`

**Do** (minimal text edits, keep original verdicts):

1. **§1 same-iteration guard**:
   - Replace absolute “cannot fire a second compact” with precise language:
     - After a **successful** proactive compact, `compactionResult` is set and blocking/predictive (historical) paths skip.
     - After a **failed** proactive compact (pre-1A), predictive could still call `autocompact` once more; **post-1A that double path is removed**, so failure no longer re-enters proactive compact in the same iteration.
   - Mention that reactive compact (413 path) is a **later** recovery, not gated by `!compactionResult` of the pre-stream proactive call.
2. **§1 “content always grows”**:
   - Delete or weaken to: “later iterations usually grow once an assistant turn + tool results land; snip/microcompact/collapse can reduce payload, so a floor-style guard is still the wrong first fix.”
3. **Line anchors**:
   - Prefer **symbol names** over brittle line numbers; where numbers remain, refresh to HEAD at edit time for:
     - `AutoCompactTrackingState`, `getAutoCompactThreshold`, `shouldAutoCompact`
     - `query.ts` `!compactionResult` sites
     - `truePostCompactTokenCount` / `willRetriggerNextTurn` in `compact.ts`
4. **Header / errata note** (short, top of file or under Audit Outcome):
   - Date of fact-check: 2026-08-03.
   - Predictive path removed under plan `context-compression-fix-plan-2026-08-03.md`.
   - §0 env snapshot is environment-local, not a repo default.

**Do not**:

- Re-litigate rejected Option A (retrigger guard) or §3 threshold raise.
- Rewrite the whole report.

**Acceptance**:

- [ ] Two overstatements corrected.
- [ ] Cross-link to this plan and to post-1A behavior.
- [ ] No claim that predictive still exists.

---

### WI-3 — Surface `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (4A)

**Design (minimal, closed loop)**:

| Surface | Behavior |
|---------|----------|
| **Startup** | Once, if override is **active** (parsed finite, `> 0` and `<= 100`), write one line to **stderr** (same pattern as ripgrep note in `init.ts`). Message must include: env name, parsed percent, and that it can only **lower** the autocompact trigger / status headroom. |
| **`/status` (Status tab)** | Add one `Property` when active: label e.g. `Autocompact override`, value e.g. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 (lowers threshold only)`. Absent when unset/invalid. |
| **Helper** | Single pure function used by both surfaces so parse rules cannot diverge from `getAutoCompactThreshold`. |

**Parse rules (must match `getAutoCompactThreshold`)**:

```text
raw = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
if missing → inactive
parsed = parseFloat(raw)
active iff !isNaN(parsed) && parsed > 0 && parsed <= 100
```

Invalid values (empty, `0`, negative, `>100`, non-numeric) → **no warn** (threshold code already ignores them).

**Implementation sketch**:

1. **`src/services/compact/autoCompact.ts`**
   - Add something like:
     - `export function getAutocompactPctOverride(): number | null`  
       returns `parsed` when active, else `null`.
   - Optionally refactor `getAutoCompactThreshold` to call this helper for the env branch (DRY; one parse path). **Preferred** so Status/startup and threshold cannot drift.
2. **`src/entrypoints/init.ts`**
   - After existing lightweight diagnostics (near ripgrep stderr pattern), if `getAutocompactPctOverride() !== null`,  
     `process.stderr.write('[autocompact] CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=… lowers autocompact threshold and status headroom\n')`.
   - No React, no notification system (init runs before UI).
3. **`src/utils/status.tsx`** (or the Status-tab property builder actually used by Settings → Status)
   - Locate where env/provider diagnostics are already listed (existing `CLAUDE_CODE_*` properties).
   - Append override property only when helper returns non-null.
   - Keep pure data: no new React components.

**Tests** (one small file or extend nearest compact test):

| Case | Expect |
|------|--------|
| unset | `null`, no status property |
| `80` | `80` |
| `0` / `-1` / `101` / `abc` | `null` |
| threshold with `80` on fixed model | `min(floor(effective*0.8), defaultThreshold)` still holds (existing math) |

Prefer **assert against runtime baseline** for window size (do not hardcode 144000) if testing threshold interaction — see project feedback on env/model-dependent pins.

**Do not**:

- Gate the env to `NODE_ENV=test` only (that was option 4C, not chosen).
- Add Settings.json persistence or UI toggle.
- Spam notifications every turn — startup once + status on demand only.

**Acceptance**:

- [ ] One parse helper; threshold uses it.
- [ ] Startup stderr once when active.
- [ ] Status tab shows row when active, hidden otherwise.
- [ ] Invalid values silent.
- [ ] Unit tests cover active/inactive parse.

---

### WI-4 — Post-compact floor observation only (5A)

**No production code change for floor budgets.**

**Do** (docs only, short section in this plan + brief note in audit doc §1 “If the slowness is real…”):

**Already emitted** (use these; do not add new events unless a gap is proven later):

| Field | Event | Meaning |
|-------|--------|---------|
| `truePostCompactTokenCount` | `tengu_compact`, also on `tengu_auto_compact_succeeded` | Rough **message payload** size after compact |
| `willRetriggerNextTurn` | `tengu_compact` | `truePostCompactTokenCount >= autoCompactThreshold` (payload-only vs full threshold — **known unit skew**; `true` is strong signal, `false` not proof of safety) |
| `tailPreservedTokens` / `tailPreservedMessages` | `tengu_compact` | Tail contribution to floor |
| `autoCompactThreshold` | `tengu_compact` | Threshold used for the flag |

**How to decide later (out of this PR’s code scope)**:

1. Sample sessions where autocompact fires.
2. If `willRetriggerNextTurn` is **frequently true**, next decision menu is **lower floor** (tail rounds / preserved user / post-compact restore) — not a suppress guard.
3. If rarely true, leave budgets alone; look at env override (§0) and compact latency instead.

**Acceptance**:

- [ ] Plan + audit doc state “measure first; no floor code in this change set”.
- [ ] No budget constant edits in the implementation PR.

---

## 3. File touch list (expected)

| Path | Change |
|------|--------|
| `src/query.ts` | Delete predictive block; drop unused imports |
| `src/services/compact/autoCompact.ts` | Delete `estimateMaxTurnGrowth` + const; add `getAutocompactPctOverride`; optional DRY in threshold |
| `src/entrypoints/init.ts` | One-time stderr warn |
| `src/utils/status.tsx` (or actual Status property module) | One conditional property |
| `src/services/compact/__tests__/*` or new small test | Override parse + (optional) threshold DRY |
| `docs/design/context-compression-audit-2026-07-31.md` | Wording + anchors + link |
| `docs/design/context-compression-fix-plan-2026-08-03.md` | This plan (living) |
| `docs/context/compaction.mdx` | **Only if** public docs mention predictive or should document the override knobs — add a short “test knobs” note for `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (behavior change is observability, not algorithm) |

Optional doc sync after code (process step 7): if Status label or stderr string is user-visible, mention in compaction docs under test/diagnostics — one paragraph max.

---

## 4. Execution order

1. WI-1 (code delete) — lowest risk, unblocks mental model.
2. WI-3 (override helper + init + status + tests) — closed observability loop.
3. WI-2 + WI-4 (docs) — after code shape is final so line/symbol anchors match.
4. `bun run precheck` (typecheck + lint fix + boundaries + tests) — must be green.
5. Sync `docs/context/compaction.mdx` only if needed for override visibility.

---

## 5. Risk & rollback

| Risk | Mitigation |
|------|------------|
| Something relied on predictive double-try after failure | Reactive compact + next-turn autocompact remain; circuit breaker still caps failures |
| Status/init import pulls heavy graph into init | Import only pure helper from `autoCompact.ts`; if init cycle appears, move helper to `effectiveWindow.ts` or tiny `autocompactOverride.ts` — **only if cycle proven** |
| Docs drift | Audit doc links to this plan; plan lists non-goals |

Rollback: revert single commit(s) per WI; WI-1 is independent of WI-3.

---

## 6. Explicit anti-patterns (reject in review)

- Re-adding predictive “but fixed”.
- New retrigger guard with mixed units.
- Changing 2k tool truncation or tail budgets “while we’re here”.
- Extracting `applyCompactionResult` with one call site.
- Feature-flagging the deletion.

---

## 7. Verification checklist (implementation gate)

```bash
# static
rg -n 'estimateMaxTurnGrowth|Predictive autocompact' src/
rg -n 'getAutocompactPctOverride|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' src/

# tests
bun test src/services/compact
# if status helper tested nearby:
# bun test <that file>

# full
bun run precheck
```

Manual smoke (optional, local):

```bash
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 bun run dev
# expect one stderr line at startup
# /status → Autocompact override row visible
unset CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
# no row, no stderr
```

---

## 8. Decision log

| # | Choice | Meaning |
|---|--------|---------|
| 1 | **A** | Delete predictive block |
| 2 | **A** | No separate yield/tracking work |
| 3 | **A** | Fix audit doc overstatements + anchors |
| 4 | **A** | Startup + `/status` warn for PCT override |
| 5 | **A** | Measure floor via existing telemetry; no budget change |

---

## 9. Plan audit gate (before coding)

This plan must be reviewed by independent agents against:

1. Factual correctness  
2. Logical correctness  
3. Completeness  
4. Operability  
5. Robustness  
6. Closed-loop design  
7. Design completeness  
8. Maintainability (code + docs)  
9. Engineering quality  
10. Need for decoupling  
11. Need for file modularization  
12. Over-engineering risk  

**Stop rule**: 3 of 4 agent results received → synthesize consensus plan → only then implement.

**Out of scope for agents**: implementing code; only plan critique + concrete patch suggestions to **this document**.

---

## 10. Consensus from plan audit (2026-08-03)

3 independent critics returned **APPROVE WITH PATCHES** (1 still in flight when stop-rule hit). No decision reopen. Applied consensus patches below become part of the executable plan.

| Patch | Source | Incorporation |
|-------|--------|---------------|
| Status pin | all 3 | Append override `Property` inside `buildAPIProviderProperties()` in `src/utils/status.tsx` (already spread by `Settings/Status.tsx` `buildPrimarySection`). No new component. |
| Init dynamic import | 2/3 | After ripgrep block in `init.ts` (~240–251): `await import('../services/compact/autoCompact.js')` then stderr write. Not a static top-level import. |
| autoCompact dead imports | 1/3 verified | Deleting `estimateMaxTurnGrowth` also drops `getMaxOutputTokensForModel` + `MAX_OUTPUT_TOKENS_FOR_SUMMARY` imports if unused. |
| Override DRY required | 2/3 | `getAutocompactPctOverride()` is **required**; `getAutoCompactThreshold` must call it (not optional). |
| 5A telemetry honesty | 2/3 | Fields are computed and passed to `logEvent`, but this fork’s 1P `tengu_*` sink is hard-off. No BQ sampling. Later measure via local debug/Datadog if on — still **no floor code**. |
| Comment scrub | optional | Soften in-source “same-turn predictive check” comments after delete. |
| Internals docs | optional / non-goal | `docs/internals/session-transcript-persistence.md` predictive mentions: out of scope unless found during `rg`; only audit + optional `compaction.mdx`. |

### Locked implementation recipe (post-consensus)

1. **WI-1** `query.ts`: delete predictive block 871–911; drop `estimateMaxTurnGrowth` + unused `getEffectiveContextWindowSize` imports.  
2. **WI-1** `autoCompact.ts`: delete `TOOL_RESULT_GROWTH_ESTIMATE`, `estimateMaxTurnGrowth`, and now-unused imports (`getMaxOutputTokensForModel`, `MAX_OUTPUT_TOKENS_FOR_SUMMARY`). Soften “predictive” comments in `compact.ts` / tests if they claim a live path.  
3. **WI-3** `autoCompact.ts`: add `getAutocompactPctOverride(): number | null` with parse identical to current threshold branch; threshold uses it.  
4. **WI-3** `init.ts`: dynamic import + one stderr line after ripgrep.  
5. **WI-3** `status.tsx`: property in `buildAPIProviderProperties()` when override active.  
6. **WI-3** tests: parse active/inactive; optional threshold min behavior with runtime baseline.  
7. **WI-2/4** docs: audit wording + this plan’s 5A honesty; no floor budget edits.  
8. `bun run precheck`.
