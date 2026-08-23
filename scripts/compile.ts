#!/usr/bin/env bun
/**
 * Cross-platform compile script.
 * Usage: bun run scripts/compile.ts [darwin-arm64|windows-x64|linux-x64]
 * Defaults to the current host platform when no argument is given.
 */
import { rmSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

const targetArg = process.argv[2] // e.g. "darwin-arm64" | "windows-x64" | "linux-x64"
const isWindows = targetArg?.startsWith('windows') ?? false
const bunTarget = targetArg ? (`bun-${targetArg}` as string) : undefined

const outdir = 'dist'
const outfile = join(outdir, isWindows ? 'ccb.exe' : 'ccb')

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
