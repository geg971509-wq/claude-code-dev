#!/usr/bin/env bun
/**
 * Cross-platform compile script.
 * Usage: bun run scripts/compile.ts [darwin-arm64|windows-x64|linux-x64]
 * Defaults to the current host platform when no argument is given.
 * After a successful compile, stages the matching vendored ripgrep next to
 * the binary so Grep works without a system rg.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'
import {
  RG_VERSION,
  type RgSidecar,
  ripgrepSidecarForTarget,
} from './ripgrep-sidecar.ts'

const DEFAULT_RG_RELEASE = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const RG_RELEASE = (
  process.env.RIPGREP_DOWNLOAD_BASE ?? DEFAULT_RG_RELEASE
).replace(/\/$/, '')
const RG_MIRROR = `https://ghproxy.net/${DEFAULT_RG_RELEASE}`

const targetArg = process.argv[2] // e.g. "darwin-arm64" | "windows-x64" | "linux-x64"
const isWindows = targetArg?.startsWith('windows') ?? false
const isLinux = targetArg?.startsWith('linux') ?? false
const bunTarget = targetArg ? (`bun-${targetArg}` as string) : undefined

const outdir = 'dist'
const outfile = join(
  outdir,
  isWindows ? 'ccb.exe' : isLinux ? 'ccb-linux' : 'ccb',
)

function findNamedFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const hit = findNamedFile(path, name)
      if (hit) return hit
    }
  }
  return null
}

function downloadRipgrep(sidecar: RgSidecar, dest: string): boolean {
  if (!sidecar.asset) return false
  const tmp = join(tmpdir(), `ccb-rg-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const archive = join(tmp, sidecar.asset)
  try {
    console.log(`Downloading ${sidecar.asset}...`)
    const urls = [`${RG_RELEASE}/${sidecar.asset}`]
    if (RG_RELEASE === DEFAULT_RG_RELEASE) {
      urls.push(`${RG_MIRROR}/${sidecar.asset}`)
    }
    let ok = false
    for (const url of urls) {
      const curl = Bun.spawnSync(['curl', '-fsSL', url, '-o', archive])
      if (curl.exitCode === 0 && existsSync(archive)) {
        ok = true
        break
      }
    }
    if (!ok) {
      console.warn(`warn: failed to download ${sidecar.asset}`)
      return false
    }
    if (sidecar.asset.endsWith('.zip')) {
      const unzip = Bun.spawnSync([
        'unzip',
        '-qo',
        archive,
        '-d',
        join(tmp, 'out'),
      ])
      if (unzip.exitCode !== 0) {
        console.warn(`warn: unzip failed for ${sidecar.asset}`)
        return false
      }
    } else {
      const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', tmp])
      if (tar.exitCode !== 0) {
        console.warn(`warn: tar extract failed for ${sidecar.asset}`)
        return false
      }
    }
    const found = findNamedFile(tmp, sidecar.bin)
    if (!found) {
      console.warn(`warn: ${sidecar.bin} not in ${sidecar.asset}`)
      return false
    }
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(found, dest)
    if (!sidecar.bin.endsWith('.exe')) chmodSync(dest, 0o755)
    console.log(`Installed ${dest}`)
    return true
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function stageRipgrep(): void {
  const sidecar = ripgrepSidecarForTarget(targetArg)
  if (!sidecar) {
    console.warn(`warn: no ripgrep mapping for target ${targetArg ?? 'host'}`)
    return
  }
  const src = join('src/utils/vendor/ripgrep', sidecar.subdir, sidecar.bin)
  const destDir = join(outdir, 'vendor', 'ripgrep', sidecar.subdir)
  const dest = join(destDir, sidecar.bin)
  if (!existsSync(src) && sidecar.asset) {
    downloadRipgrep(sidecar, src)
  }
  if (!existsSync(src)) {
    console.warn(
      `warn: missing ${src} (Grep may need system rg on that platform)`,
    )
    return
  }
  mkdirSync(destDir, { recursive: true })
  cpSync(src, dest)
  if (!sidecar.bin.endsWith('.exe')) chmodSync(dest, 0o755)
  console.log(`Staged ${sidecar.subdir}/${sidecar.bin}`)
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
stageRipgrep()
