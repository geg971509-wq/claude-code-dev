# Compact Progress UI Fix Plan

**Date**: 2026-08-03  
**Branch**: `fix/stream-lifecycle-hardening`  
**Locked decision**: **1A** only  
**Scope**: Spinner compact progress label honesty — not threshold math, not floor budgets, not predictive (already removed).

---

## 0. Decision record

| ID | Choice | Meaning |
|----|--------|---------|
| **1A** | Keep asymptotic activity bar; **stop claiming completion %** | Summary length is unknown until stream ends. Curve + 0.99 clamp stay. UI must not present the curve as “percent done.” |

**Not authorized this round** (not presented / not chosen): 1B linear-vs-expected, 1C tokens-only, 1D indeterminate-only, 1E no-op; curve scale `1200`; `chars/4` estimator; token-counter lag; SM compact path without bar.

---

## 1. Evidence (re-derive at implement time)

### 1.1 Where the % lives

| Piece | Location | Role |
|-------|----------|------|
| Curve + clamp | `src/components/Spinner/SpinnerAnimationRow.tsx` ~289–328 | `compactRatio = min(0.99, 1 - exp(-leaderTokens/1200))`; label `Math.round(compactRatio * 100)%` (delete label under 1A) |
| Token input | same spinner file ~169–170 | `leaderTokens = round(displayedResponseLength / 4)`; length is **animation-smoothed** (50ms), not raw `responseLengthRef`. Do not “fix” lag under 1A. |
| Active flag | `src/screens/REPL.tsx` ~1752, ~3015–3023 | `compactProgressActiveRef` set on `compact_start` / cleared on `compact_end` only |
| Lifecycle | REPL `onCompactProgress` + `compact.ts` | `hooks_start` changes spinner **message** only; does **not** clear the ref. Bar may **freeze** through post_compact / session_start hooks until `finally` `compact_end`. Pre-existing; out of 1A. |
| Stream length | `src/services/compact/compact.ts` | `setResponseLength` zeroed on start; text_delta / fork `shareSetResponseLength` feeds chars |
| Events | `src/Tool.ts` `CompactProgressEvent` | `hooks_start` \| `compact_start` \| `compact_end` only — **no** expected total, no real ratio |
| Bar widget | `packages/@ant/ink/src/theme/ProgressBar.tsx` | Renders ratio ∈ [0,1] via `BLOCKS`. **Clamp rationale is in SpinnerAnimationRow**, not this primitive; narrow widths can still paint a full last cell at 0.99. |

### 1.2 Why % is dishonest

- Comment in spinner already states: summary length unknown → asymptotic “forward motion,” not completion.
- Clamp at 0.99 is load-bearing so the bar never looks finished while stream may hang.
- Displaying `99%` still reads as “almost done” in user language — same lie, softer form.
- Compact summary size: comment in `effectiveWindow.ts` cites p99.99 ≈ **17,387** tokens; `MAX_OUTPUT_TOKENS_FOR_SUMMARY` is the **reserve cap 20_000** (not “the p99”). Curve τ=1200 is near the 0.99 clamp long before either figure — evidence the curve is not percent of real summary length, not a license to invent 1B totals.
- **Residual after removing the label (accepted under 1A, not a follow-up):** the bar can still park near-full for long streams (curve + clamp). That may still *feel* like “almost done.” 1A trades numeric false precision for partial honesty; full non-completion UI would be **1D** (not authorized). Do not “fix” residual by inventing an endpoint or soft labels (`~99%`, “almost done”).

### 1.3 What 1A does **not** change

- ProgressBar presence and `compactRatio` math (still drives bar fill).
- `compact_start` / `compact_end` / hooks spinner messages.
- Autocompact thresholds, override env, compact algorithms.
- Remote/SDK status strings (`Compacting conversation…`) unless they show a fake % (today: text only, `sdkMessageAdapter.ts`).
- Do **not** clear `compactProgressActiveRef` on `hooks_start` or invent stage-aware bar logic (bar freeze during post hooks is pre-existing residual).
- Do **not** retune τ, chars/4, token-counter lag, or SM compact path.

---

## 2. Goals / non-goals

**Goals**

1. User-visible compact UI no longer shows a **completion percentage** derived from the asymptotic curve.
2. Keep a **non-percent activity indicator** (ProgressBar with same curve + clamp) so streaming still feels forward.
3. Shortest working diff; comment updated so future edits do not re-add `%`.
4. `bun run precheck` green.

**Non-goals**

- Calibrating τ=1200 or inventing expected-summary length (1B).
- Replacing bar with raw token % of max output.
- New telemetry, feature flags, settings.
- Session-memory compact progress (no stream length today).
- Extracting a shared progress module unless a critic proves a second call site needs the same formula.

---

## 3. Work items

### WI-1 — Drop completion % label (1A core)

**File**: `src/components/Spinner/SpinnerAnimationRow.tsx`

**Do**

1. Keep `isCompacting`, `compactRatio` (incl. `Math.min(0.99, …)`), `ProgressBar`.
2. Remove the label that formats completion percent, currently:
   ```tsx
   <Text dimColor> {Math.round(compactRatio * 100)}%</Text>
   ```
3. Do **not** replace with another completion-like number (`99`, `0.99`, “almost done”).
4. Prefer **no substitute text** next to the bar — spinner message already says `Compacting conversation`. Removing the whole `<Text>…%</Text>` node also removes the leading space.
5. Update the block comment above the curve:
   - State explicitly: bar is **activity / streamed volume**, not percent complete.
   - Keep the 0.99 / ProgressBar remainder-glyph (`BLOCKS[8] === '█'`) rationale; note narrow widths can still look full.
   - One line: do not reintroduce a `%` label without a known total.
6. Same change set, comment-only: soften prop JSDocs that say bare “token progress bar”:
   - `SpinnerAnimationRow.tsx` + `Spinner.tsx` prop on `compactProgressActiveRef` → activity bar wording (not completion %).
7. Optional non-blocking comment-only: `compact.ts` fork note “bar sits at 0%” → “bar sits empty / at zero fill” (not user-facing).

**Do not**

- Change τ=1200 or the exp formula in this WI.
- Add i18n strings / new settings.
- Touch `ProgressBar` ink primitive for this alone.
- Clear ref on `hooks_start` or linearize vs `MAX_OUTPUT_TOKENS_FOR_SUMMARY`.

**Acceptance**

- During compact, UI shows ProgressBar without `N%` or any completion-like adjacent number/text.
- Residual near-full bar fill without `N%` is **accepted** under 1A; do not expand fill semantics.
- Concurrent spinner `N tokens` volume text may still appear — volume, not completion %; leave it.
- During PostCompact/SessionStart hooks, bar may sit frozen near clamp — do not “fix” in this WI.
- Non-compact path unchanged (early `if (!isCompacting) return spinnerRow`).
- Comment + prop JSDocs document non-completion semantics.
- Grep: no other compact spinner completion `%` (exclude TokenWarning / context-used / budget Target %).

### WI-2 — Tests (minimal)

**Reality**: no existing `Spinner/**/__tests__` for this row.

**Do (prefer one of)**

| Option | When |
|--------|------|
| **T0** | No new test if change is delete-only of display Text and precheck is enough (ponytail default for pure presentational delete). |
| **T1** | If implementer extracts pure `compactActivityRatio(tokens): number` for testability — one file unit test: monotonic, cap ≤ 0.99, never 1.0. **Only extract if** the formula stays and a pure function is a one-liner move; do not invent a module for one call site. |

**Do not** mount full Ink Spinner in this plan (high cost, not authorized).

### WI-3 — Docs

| Doc | Action |
|-----|--------|
| This plan | Consensus section after agent audit |
| Public Mintlify compact docs | Only if they mention compact progress % (grep at implement; likely none) |
| `docs/design/*` audit docs | No requirement unless they claim a real % progress UI |
| User-facing changelog | Not required |

If no public doc mentions the %, **WI-3 = no doc product change** beyond this plan file.

---

## 4. Implementation order

1. WI-1 code + comment  
2. WI-2 only if pure extract chosen  
3. Grep repo for compact progress `%` claims; WI-3 if any  
4. `bun run precheck`

---

## 5. Risks

| Risk | Mitigation |
|------|------------|
| Users liked seeing a number | 1A intentionally trades false precision for honesty; bar remains |
| Someone re-adds `%` later | Comment + this plan; keep clamp |
| Empty-looking row after removing Text | Bar alone is enough; spinner title already explains phase |
| Near-full bar still feels like completion | Accepted 1A residual; only 1D removes it; do not invent totals |
| Implementer “helps” by linearizing vs 20k max output | Reject — 1B-ish, not authorized |
| Critic scope creep into 1B/1C | Reject; only 1A locked |

---

## 6. Anti-patterns (do not ship)

- `Math.round(compactRatio * 100)` under any label (“approx”, “~99%”) that still looks like completion.
- Linear `tokens / MAX_OUTPUT_TOKENS_FOR_SUMMARY` without a new decision (that is 1B-ish).
- New feature flag for label style.
- New file/module for a single JSX delete.
- Changing remote bridge compact strings unless they show fake %.

---

## 7. Verification checklist

- [x] Grep `compactRatio * 100` / completion `%` next to compact ProgressBar — gone from spinner path
- [x] No substitute completion-like adjacent text (`~99%`, “almost done”, bare `99`)
- [x] Prop JSDocs on `compactProgressActiveRef` say activity bar / not completion % (`SpinnerAnimationRow.tsx`, `Spinner.tsx`)
- [x] Mental path: `compact_start` → bar moves with stream → `compact_end` bar gone; freeze during hooks is residual
- [x] Grep does not “fix” TokenWarning / budget `Target: …%` / context-used %
- [x] `bun run precheck` (6511 pass / 0 fail)
- [x] Diff has no autocompact threshold / τ / expected-total changes

---

## 8. Rollback

Revert the same files the implement recipe touched (typically):

- `src/components/Spinner/SpinnerAnimationRow.tsx` (label + block comment + prop JSDoc)
- `src/components/Spinner.tsx` (prop JSDoc only, if changed)
- `src/services/compact/compact.ts` (fork “0%” wording only, if changed)

No threshold / formula / ProgressBar primitive rollback required for 1A.

---

## 9. Consensus (filled after ≥3 agent audits)

**Stop rule:** 3 of 4 independent critics returned finals (4th not required).  
**Model note:** user asked `grok-4.5-xhigh`; Agent tool tiers are sonnet/opus/haiku → critics ran **sonnet**.

| Agent | Verdict |
|-------|---------|
| 1 | APPROVE WITH PATCHES |
| 2 | APPROVE WITH PATCHES |
| 3 | APPROVE WITH PATCHES |
| 4 (late) | APPROVE WITH PATCHES — plan-text rollback + verification hygiene only |

**Consensus patches applied above (plan text):** residual honesty of near-full bar as accepted 1A leftover; p99.99 **17,387** vs reserve **20_000** precision; clamp rationale owned by spinner not ink primitive; smoothed token input; hooks freeze lifecycle out of scope; prop JSDocs + optional `compact.ts` “0%” wording; acceptance blesses residual fill; no soft `%` renames; multi-file rollback list.

**Implement recipe (shortest):**

1. `SpinnerAnimationRow.tsx`: delete `<Text dimColor> {Math.round(compactRatio * 100)}%</Text>`; keep curve/clamp/ProgressBar; rewrite block comment; soften prop JSDoc.
2. `Spinner.tsx`: matching prop JSDoc only.
3. Optional: `compact.ts` “0%” comment → zero fill.
4. T0 — no new tests unless pure extract (not preferred).
5. Grep docs for compact progress `%` claims; product docs likely none.
6. `bun run precheck`.

**Status 2026-08-03:** recipe **landed** in working tree; precheck green. Not committed unless user asks.

**Do not reopen 1A.** Do not ship 1B/1C/1D/1E, τ retune, or hooks-phase bar lifecycle changes.
