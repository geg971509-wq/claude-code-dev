#!/usr/bin/env bun
/**
 * Cross-platform compile script.
 * Usage: bun run scripts/compile.ts [darwin-arm64|windows-x64|linux-x64]
 * Defaults to the current host platform when no argument is given.
 * After a successful compile, stages the matching vendored ripgrep next to
 * the binary so Grep works without a system rg.
 */
import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'
import { stageRipgrep } from './ripgrep-sidecar.ts'

const targetArg = process.argv[2] // e.g. "darwin-arm64" | "windows-x64" | "linux-x64"
const isWindows = targetArg?.startsWith('windows') ?? false
const isLinux = targetArg?.startsWith('linux') ?? false
const bunTarget = targetArg ? (`bun-${targetArg}` as string) : undefined

const outdir = 'dist'
const outfile = join(
  outdir,
  isWindows ? 'ccb.exe' : isLinux ? 'ccb-linux' : 'ccb',
)

function stageComputerUse(): void {
  const dest = join(outdir, 'vendor', 'computer-use')
  rmSync(dest, { recursive: true, force: true })
  if (isWindows || isLinux) return
  cpSync('vendor/computer-use', dest, { recursive: true })
  console.log('Staged vendor/computer-use/')
}

mkdirSync(outdir, { recursive: true })
try {
  rmSync(outfile, { force: true })
} catch {
  // ignore
}

const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

console.log(`Compiling ${bunTarget ?? 'host'} → ${outfile}`)
console.log(`Features (${features.length}): ${features.join(', ')}`)

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  compile: { outfile },
  // Keep runtime code split so Bun/JSC does not eagerly parse the full CLI.
  splitting: true,
  // bunTarget overrides the default host platform for cross-compilation;
  // 'bun' is the fallback that Bun resolves to the current host.
  target: (bunTarget ?? 'bun') as 'bun',
  define: {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})

if (!result.success) {
  console.error('Compile failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

if (!isWindows) chmodSync(outfile, 0o755)

for (const out of result.outputs) {
  console.log(`  ${out.path} (${out.size} bytes, ${out.kind})`)
}

console.log(`Done: ${outfile}`)
stageRipgrep({ outdir, target: targetArg })
stageComputerUse()
