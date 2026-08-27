import { readdir, readFile, writeFile, cp } from 'fs/promises'
import { join } from 'path'
import { getMacroDefines } from './scripts/defines.ts'
import { DEFAULT_BUILD_FEATURES } from './scripts/defines.ts'
import {
  CLI_BUN_WRAPPER_SOURCE,
  CLI_NODE_WRAPPER_SOURCE,
} from './scripts/cli-entry-wrappers.ts'
import { stageRipgrep } from './scripts/ripgrep-sidecar.ts'

const outdir = 'dist'

// Step 1: Clean output directory
const { rmSync } = await import('fs')
rmSync(outdir, { recursive: true, force: true })

// Collect FEATURE_* env vars → Bun.build features
const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// Step 2: Bundle with splitting
const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  target: 'bun',
  splitting: true,
  sourcemap: 'linked',
  define: {
    ...getMacroDefines(),
    // React production mode — eliminates _debugStack Error objects
    // (6,889 objects × ~1.7KB = 12MB in development builds) and removes
    // prop-type / key warnings not useful in a production CLI tool.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Step 3: Post-process — replace Bun-only `import.meta.require` with Node.js compatible version
const files = await readdir(outdir)
const IMPORT_META_REQUIRE = 'var __require = import.meta.require;'
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`

let patched = 0
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (content.includes(IMPORT_META_REQUIRE)) {
    await writeFile(
      filePath,
      content.replace(IMPORT_META_REQUIRE, COMPAT_REQUIRE),
    )
    patched++
  }
}

// Also patch unguarded globalThis.Bun destructuring from third-party deps
// (e.g. @anthropic-ai/sandbox-runtime) so Node.js doesn't crash at import time.
let bunPatched = 0
const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g
const BUN_DESTRUCTURE_SAFE =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};'
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (BUN_DESTRUCTURE.test(content)) {
    await writeFile(
      filePath,
      content.replace(BUN_DESTRUCTURE, BUN_DESTRUCTURE_SAFE),
    )
    bunPatched++
  }
}
BUN_DESTRUCTURE.lastIndex = 0

console.log(
  `Bundled ${result.outputs.length} files to ${outdir}/ (patched ${patched} for import.meta.require, ${bunPatched} for Bun destructure)`,
)

// Step 4: Copy native addons and vendored binaries.
const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
await cp('vendor/audio-capture', audioCaptureDir, { recursive: true })
console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`)

const computerUseDir = join(outdir, 'vendor', 'computer-use')
await cp('vendor/computer-use', computerUseDir, { recursive: true })
console.log(`Copied vendor/computer-use/ → ${computerUseDir}/`)

stageRipgrep({ outdir, allKnown: true })

// Step 5: Generate cli-bun and cli-node executable entry points.
// Wrapper sources (runtime version gates) are shared with scripts/post-build.ts
// via scripts/cli-entry-wrappers.ts — single source of truth, no drift.
const cliBun = join(outdir, 'cli-bun.js')
const cliNode = join(outdir, 'cli-node.js')

await writeFile(cliBun, CLI_BUN_WRAPPER_SOURCE)

await writeFile(cliNode, CLI_NODE_WRAPPER_SOURCE)

// Make both executable
const { chmodSync } = await import('fs')
chmodSync(cliBun, 0o755)
chmodSync(cliNode, 0o755)

console.log(`Generated ${cliBun} (shebang: bun) and ${cliNode} (shebang: node)`)
