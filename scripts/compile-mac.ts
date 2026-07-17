#!/usr/bin/env bun
/**
 * Compile a standalone macOS binary via Bun --compile.
 * Output: dist/ccb (Mach-O executable)
 */
import { rmSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

const outdir = 'dist'
const outfile = join(outdir, 'ccb')

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

console.log(`Compiling macOS binary → ${outfile}`)
console.log(`Features (${features.length}): ${features.join(', ')}`)

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  // compile mode embeds into a single executable; outfile required
  compile: {
    outfile,
    // keep default target = host (darwin-arm64 here)
  },
  target: 'bun',
  // compile implies production minify; no splitting for standalone binary
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

chmodSync(outfile, 0o755)

for (const out of result.outputs) {
  console.log(`  ${out.path} (${out.size} bytes, ${out.kind})`)
}

console.log(`Done: ${outfile}`)
