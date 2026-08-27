import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codeSignOrder,
  createReleasePlan,
  prepareReleaseOutput,
  renderLauncher,
} from '../release-macos.js'

const env = {
  MACOS_APPLICATION_IDENTITY: 'Developer ID Application: Test (TEAM)',
  MACOS_INSTALLER_IDENTITY: 'Developer ID Installer: Test (TEAM)',
  MACOS_NOTARY_KEYCHAIN_PROFILE: 'test-profile',
}

describe('createReleasePlan', () => {
  test('uses the approved universal PKG-in-DMG layout', () => {
    const plan = createReleasePlan(
      { mode: 'local', arch: 'universal', outputDir: 'release/macos' },
      {},
      '2.8.6',
    )

    expect(plan.installRoot).toBe('/usr/local/lib/claude-code-best')
    expect(plan.packageIdentifier).toBe('win.claude-code-best.cli')
    expect(plan.pkg).toEndWith('claude-code-best-2.8.6-macos-universal.pkg')
    expect(plan.dmg).toEndWith('claude-code-best-2.8.6-macos-universal.dmg')
    expect(plan.compileTargets).toEqual(['darwin-arm64', 'darwin-x64'])
    expect(plan.sign).toBe(false)
    expect(plan.notarize).toBe(false)
  })

  test('requires both Developer ID identities for signed mode', () => {
    expect(() =>
      createReleasePlan(
        { mode: 'signed', arch: 'universal', outputDir: 'release/macos' },
        {},
        '2.8.6',
      ),
    ).toThrow('MACOS_APPLICATION_IDENTITY')
    expect(() =>
      createReleasePlan(
        { mode: 'signed', arch: 'universal', outputDir: 'release/macos' },
        { MACOS_APPLICATION_IDENTITY: env.MACOS_APPLICATION_IDENTITY },
        '2.8.6',
      ),
    ).toThrow('MACOS_INSTALLER_IDENTITY')
  })

  test('requires a keychain profile when notarization is enabled', () => {
    expect(() =>
      createReleasePlan(
        {
          mode: 'signed',
          arch: 'universal',
          outputDir: 'release/macos',
          notarize: true,
        },
        {
          MACOS_APPLICATION_IDENTITY: env.MACOS_APPLICATION_IDENTITY,
          MACOS_INSTALLER_IDENTITY: env.MACOS_INSTALLER_IDENTITY,
        },
        '2.8.6',
      ),
    ).toThrow('MACOS_NOTARY_KEYCHAIN_PROFILE')

    expect(
      createReleasePlan(
        {
          mode: 'signed',
          arch: 'universal',
          outputDir: 'release/macos',
          notarize: true,
        },
        env,
        '2.8.6',
      ).notarize,
    ).toBe(true)
  })
})

describe('renderLauncher', () => {
  test('routes every native sidecar from the stable install root', () => {
    const launcher = renderLauncher('/usr/local/lib/claude-code-best')

    expect(launcher).toContain('arm64) native_arch=arm64')
    expect(launcher).toContain('x86_64) native_arch=x64')
    expect(launcher).toContain('AUDIO_CAPTURE_NODE_PATH=')
    expect(launcher).toContain('COMPUTER_USE_INPUT_NODE_PATH=')
    expect(launcher).toContain('COMPUTER_USE_SWIFT_NODE_PATH=')
    expect(launcher).toContain('exec "$install_root/ccb" "$@"')
  })
})

describe('codeSignOrder', () => {
  test('signs nested Mach-O code before the standalone executable', () => {
    const paths = codeSignOrder('/payload')

    expect(paths.at(-1)).toBe('/payload/ccb')
    expect(paths).toContain(
      '/payload/vendor/computer-use/computer-use-input.node',
    )
    expect(paths).toContain(
      '/payload/vendor/computer-use/computer-use-swift.node',
    )
    expect(paths).toContain(
      '/payload/vendor/audio-capture/arm64-darwin/audio-capture.node',
    )
    expect(paths).toContain('/payload/vendor/ripgrep/x64-darwin/rg')
  })
})

describe('prepareReleaseOutput', () => {
  test('cleans owned paths without deleting unrelated output files', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ccb-release-'))
    try {
      const plan = createReleasePlan(
        { mode: 'local', arch: 'universal', outputDir },
        {},
        '2.8.6',
      )
      const keep = join(outputDir, 'keep.txt')
      const staleWork = join(plan.workDir, 'stale.txt')
      mkdirSync(plan.workDir, { recursive: true })
      writeFileSync(keep, 'keep')
      writeFileSync(staleWork, 'stale')
      for (const path of [plan.pkg, plan.dmg, plan.manifest, plan.checksums]) {
        writeFileSync(path, 'stale')
      }

      prepareReleaseOutput(plan)

      expect(existsSync(keep)).toBe(true)
      expect(existsSync(staleWork)).toBe(false)
      expect(existsSync(plan.workDir)).toBe(true)
      for (const path of [plan.pkg, plan.dmg, plan.manifest, plan.checksums]) {
        expect(existsSync(path)).toBe(false)
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
