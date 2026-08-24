/**
 * Compile-target → vendored ripgrep sidecar.
 * Layout matches src/utils/ripgrep.ts: dist/vendor/ripgrep/{arch}-{platform}/rg[.exe]
 */
export const RG_VERSION = '15.0.1'

export type RgSidecar = { subdir: string; bin: string; asset: string }

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
