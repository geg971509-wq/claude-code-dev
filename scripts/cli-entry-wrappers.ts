/**
 * Shared cli-bun.js / cli-node.js entry-wrapper sources.
 *
 * Single source of truth for the runtime version gates written into
 * dist/ by BOTH build pipelines:
 *   - build.ts        (Bun.build, Step 5)
 *   - scripts/post-build.ts (Vite pipeline, Step 3)
 *
 * Keep the gates additive-only (no public API change). Dynamic import is
 * required so the gate runs before cli.js loads (static import is hoisted).
 * Bun min matches package.json engines.bun; Node floor is LTS-era ESM baseline.
 */

export const CLI_BUN_WRAPPER_SOURCE = `#!/usr/bin/env bun
// status + reason + next — engines.bun gate (additive wrapper only)
const MIN_BUN = [1, 3, 0]
function parseSemver(v) {
  const m = String(v || '').match(/(\\d+)\\.(\\d+)\\.(\\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function lt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true
    if (a[i] > b[i]) return false
  }
  return false
}
const bunVer = typeof Bun !== 'undefined' ? Bun.version : process.versions?.bun
const parsed = parseSemver(bunVer)
if (parsed && lt(parsed, MIN_BUN)) {
  console.error(
    'status: Bun ' +
      bunVer +
      ' is below engines.bun (>=1.3.0).\\n' +
      'reason: CCB requires Bun features/runtime fixes from 1.3+. Canary builds may report a version ahead of stable — if install failed on engines, pin a stable >=1.3.0.\\n' +
      'next: bun upgrade   # or install from https://bun.sh',
  )
  process.exit(1)
}
await import("./cli.js")
`

export const CLI_NODE_WRAPPER_SOURCE = `#!/usr/bin/env node
// status + reason + next — Node floor for dist/cli-node.js (additive wrapper only)
const MIN_NODE_MAJOR = 18
const major = Number(String(process.versions.node || '0').split('.')[0])
if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
  console.error(
    'status: Node ' +
      process.version +
      ' is below the supported floor (Node >=18).\\n' +
      'reason: dist/cli-node.js targets modern Node ESM/runtime APIs used by the CLI bundle.\\n' +
      'next: upgrade Node to 18+ (20 LTS recommended), or run with Bun via ccb-bun / dist/cli-bun.js',
  )
  process.exit(1)
}
await import("./cli.js")
`
