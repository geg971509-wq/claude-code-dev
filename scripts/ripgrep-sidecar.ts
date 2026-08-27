/**
 * Compile-target → vendored ripgrep sidecar.
 * Layout matches src/utils/ripgrep.ts: dist/vendor/ripgrep/{arch}-{platform}/rg[.exe]
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

export const RG_VERSION = '15.0.1'

export type RgSidecar = { subdir: string; bin: string; asset: string }

const DEFAULT_RG_RELEASE = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const RG_RELEASE = (
  process.env.RIPGREP_DOWNLOAD_BASE ?? DEFAULT_RG_RELEASE
).replace(/\/$/, '')
const RG_MIRROR = `https://ghproxy.net/${DEFAULT_RG_RELEASE}`

const SIDECARS: Record<string, RgSidecar> = {
  'windows-x64': {
    subdir: 'x64-win32',
    bin: 'rg.exe',
    asset: `ripgrep-v${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
  },
  'win32-x64': {
    subdir: 'x64-win32',
    bin: 'rg.exe',
    asset: `ripgrep-v${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
  },
  'linux-x64': {
    subdir: 'x64-linux',
    bin: 'rg',
    asset: `ripgrep-v${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
  },
  'darwin-arm64': {
    subdir: 'arm64-darwin',
    bin: 'rg',
    asset: `ripgrep-v${RG_VERSION}-aarch64-apple-darwin.tar.gz`,
  },
  'darwin-x64': {
    subdir: 'x64-darwin',
    bin: 'rg',
    asset: `ripgrep-v${RG_VERSION}-x86_64-apple-darwin.tar.gz`,
  },
}

export function ripgrepSidecarForTarget(
  target?: string,
  host: { platform: NodeJS.Platform; arch: string } = process,
): RgSidecar | null {
  const key = target ?? `${host.platform}-${host.arch}`
  const mapped = SIDECARS[key]
  if (mapped) return mapped
  if (target) return null
  return {
    subdir: `${host.arch}-${host.platform}`,
    bin: host.platform === 'win32' ? 'rg.exe' : 'rg',
    asset: '',
  }
}

export function allRipgrepSidecars(): RgSidecar[] {
  const seen = new Set<string>()
  const out: RgSidecar[] = []
  for (const sidecar of Object.values(SIDECARS)) {
    if (seen.has(sidecar.subdir)) continue
    seen.add(sidecar.subdir)
    out.push(sidecar)
  }
  return out
}

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

export function downloadRipgrep(sidecar: RgSidecar, dest: string): boolean {
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

function stageOne(
  outdir: string,
  sidecar: RgSidecar,
  targetLabel: string,
): void {
  const src = join('src/utils/vendor/ripgrep', sidecar.subdir, sidecar.bin)
  const destDir = join(outdir, 'vendor', 'ripgrep', sidecar.subdir)
  const dest = join(destDir, sidecar.bin)
  if (!existsSync(src) && sidecar.asset) {
    downloadRipgrep(sidecar, src)
  }
  if (!existsSync(src)) {
    console.warn(
      `warn: missing ${src} (Grep may need system rg on ${targetLabel})`,
    )
    return
  }
  mkdirSync(destDir, { recursive: true })
  cpSync(src, dest)
  if (!sidecar.bin.endsWith('.exe')) chmodSync(dest, 0o755)
  console.log(`Staged ${sidecar.subdir}/${sidecar.bin}`)
}

/** Copy vendored rg into dist/. Missing binaries download first, then warn-and-skip. */
export function stageRipgrep(opts: {
  outdir: string
  target?: string
  allKnown?: boolean
}): void {
  if (opts.allKnown) {
    for (const sidecar of allRipgrepSidecars()) {
      stageOne(opts.outdir, sidecar, sidecar.subdir)
    }
    return
  }
  const sidecar = ripgrepSidecarForTarget(opts.target)
  if (!sidecar) {
    console.warn(`warn: no ripgrep mapping for target ${opts.target ?? 'host'}`)
    return
  }
  stageOne(opts.outdir, sidecar, opts.target ?? 'host')
}
