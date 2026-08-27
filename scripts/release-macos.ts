#!/usr/bin/env bun
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import packageJson from '../package.json'

type ReleaseArch = 'universal' | 'arm64' | 'x64'
type ReleaseMode = 'local' | 'signed'

export type ReleaseOptions = {
  mode: ReleaseMode
  arch: ReleaseArch
  outputDir: string
  notarize?: boolean
  planOnly?: boolean
}

type ReleaseEnvironment = Partial<
  Record<
    | 'MACOS_APPLICATION_IDENTITY'
    | 'MACOS_INSTALLER_IDENTITY'
    | 'MACOS_NOTARY_KEYCHAIN_PROFILE',
    string
  >
>

export type ReleasePlan = {
  version: string
  arch: ReleaseArch
  mode: ReleaseMode
  sign: boolean
  notarize: boolean
  outputDir: string
  workDir: string
  payloadRoot: string
  payloadInstallDir: string
  installRoot: string
  packageIdentifier: string
  artifactBase: string
  pkg: string
  dmg: string
  manifest: string
  checksums: string
  compileTargets: string[]
  applicationIdentity?: string
  installerIdentity?: string
  notaryProfile?: string
}

const PACKAGE_IDENTIFIER = 'win.claude-code-best.cli'
const DEFAULT_OUTPUT_DIR = 'release/macos'
const ENTITLEMENTS = resolve(import.meta.dir, 'macos.entitlements.plist')

function requiredEnv(
  env: ReleaseEnvironment,
  name: keyof ReleaseEnvironment,
): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function compileTargets(arch: ReleaseArch): string[] {
  if (arch === 'universal') return ['darwin-arm64', 'darwin-x64']
  return [`darwin-${arch}`]
}

function assertSafeOutputDir(outputDir: string): void {
  const root = resolve(outputDir)
  const protectedPaths = new Set([
    resolve('/'),
    resolve(process.cwd()),
    resolve(process.env.HOME ?? '/'),
  ])
  if (protectedPaths.has(root)) {
    throw new Error(`refusing unsafe release output directory: ${root}`)
  }
}

export function createReleasePlan(
  options: ReleaseOptions,
  env: ReleaseEnvironment = process.env,
  version = packageJson.version,
): ReleasePlan {
  assertSafeOutputDir(options.outputDir)
  const sign = options.mode === 'signed'
  const notarize = options.notarize === true
  if (notarize && !sign) {
    throw new Error('notarization requires signed mode')
  }

  const applicationIdentity = sign
    ? requiredEnv(env, 'MACOS_APPLICATION_IDENTITY')
    : undefined
  const installerIdentity = sign
    ? requiredEnv(env, 'MACOS_INSTALLER_IDENTITY')
    : undefined
  const notaryProfile = notarize
    ? requiredEnv(env, 'MACOS_NOTARY_KEYCHAIN_PROFILE')
    : undefined

  const outputDir = resolve(options.outputDir)
  const workDir = join(outputDir, '.claude-code-best-release-work')
  const installRoot = '/usr/local/lib/claude-code-best'
  const payloadRoot = join(workDir, 'payload-root')
  const payloadInstallDir = join(payloadRoot, installRoot.slice(1))
  const artifactBase = `claude-code-best-${version}-macos-${options.arch}`

  return {
    version,
    arch: options.arch,
    mode: options.mode,
    sign,
    notarize,
    outputDir,
    workDir,
    payloadRoot,
    payloadInstallDir,
    installRoot,
    packageIdentifier: PACKAGE_IDENTIFIER,
    artifactBase,
    pkg: join(outputDir, `${artifactBase}.pkg`),
    dmg: join(outputDir, `${artifactBase}.dmg`),
    manifest: join(outputDir, 'release-manifest.json'),
    checksums: join(outputDir, 'SHA256SUMS'),
    compileTargets: compileTargets(options.arch),
    applicationIdentity,
    installerIdentity,
    notaryProfile,
  }
}

export function prepareReleaseOutput(plan: ReleasePlan): void {
  mkdirSync(plan.outputDir, { recursive: true })
  rmSync(plan.workDir, { recursive: true, force: true })
  for (const path of [plan.pkg, plan.dmg, plan.manifest, plan.checksums]) {
    rmSync(path, { force: true })
  }
  mkdirSync(plan.workDir, { recursive: true })
}

export function renderLauncher(installRoot: string): string {
  return `#!/bin/sh
set -eu
install_root="\${CCB_INSTALL_ROOT:-${installRoot}}"
case "$(uname -m)" in
  arm64) native_arch=arm64 ;;
  x86_64) native_arch=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
export AUDIO_CAPTURE_NODE_PATH="\${AUDIO_CAPTURE_NODE_PATH:-$install_root/vendor/audio-capture/$native_arch-darwin/audio-capture.node}"
export COMPUTER_USE_INPUT_NODE_PATH="\${COMPUTER_USE_INPUT_NODE_PATH:-$install_root/vendor/computer-use/computer-use-input.node}"
export COMPUTER_USE_SWIFT_NODE_PATH="\${COMPUTER_USE_SWIFT_NODE_PATH:-$install_root/vendor/computer-use/computer-use-swift.node}"
exec "$install_root/ccb" "$@"
`
}

function selectedArchDirs(arch: ReleaseArch): string[] {
  if (arch === 'universal') return ['arm64-darwin', 'x64-darwin']
  return [`${arch}-darwin`]
}

export function codeSignOrder(
  payloadInstallDir: string,
  arch: ReleaseArch = 'universal',
): string[] {
  const nested = [
    ...selectedArchDirs(arch).map(dir =>
      join(
        payloadInstallDir,
        'vendor',
        'audio-capture',
        dir,
        'audio-capture.node',
      ),
    ),
    join(
      payloadInstallDir,
      'vendor',
      'computer-use',
      'computer-use-input.node',
    ),
    join(
      payloadInstallDir,
      'vendor',
      'computer-use',
      'computer-use-swift.node',
    ),
    ...selectedArchDirs(arch).map(dir =>
      join(payloadInstallDir, 'vendor', 'ripgrep', dir, 'rg'),
    ),
  ]
  return [...nested, join(payloadInstallDir, 'ccb')]
}

function commandText(cmd: string[]): string {
  return cmd
    .map(part =>
      /^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part),
    )
    .join(' ')
}

function run(cmd: string[], capture = false, cwd?: string): string {
  console.log(`$ ${commandText(cmd)}`)
  const result = Bun.spawnSync({
    cmd,
    stdout: capture ? 'pipe' : 'inherit',
    stderr: capture ? 'pipe' : 'inherit',
    env: process.env,
    cwd,
  })
  if (result.exitCode !== 0) {
    const stderr = capture ? result.stderr.toString().trim() : ''
    throw new Error(
      `${commandText(cmd)} failed with exit ${result.exitCode}${stderr ? `: ${stderr}` : ''}`,
    )
  }
  return capture ? result.stdout.toString().trim() : ''
}

function ensureDarwin(): void {
  if (process.platform !== 'darwin') {
    throw new Error('macOS release packaging must run on macOS')
  }
}

function ensureFiles(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path))
      throw new Error(`required release input missing: ${path}`)
  }
}

function compileStandalone(plan: ReleasePlan): Map<string, string> {
  const binaries = new Map<string, string>()
  const binDir = join(plan.workDir, 'compiled')
  mkdirSync(binDir, { recursive: true })

  for (const target of plan.compileTargets) {
    run(['bun', 'run', 'scripts/compile.ts', target])
    const source = resolve('dist/ccb')
    ensureFiles([source])
    const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
    const destination = join(binDir, `ccb-${arch}`)
    copyFileSync(source, destination)
    chmodSync(destination, 0o755)
    binaries.set(arch, destination)
  }
  return binaries
}

function createStandalone(
  plan: ReleasePlan,
  binaries: Map<string, string>,
): void {
  const output = join(plan.payloadInstallDir, 'ccb')
  mkdirSync(plan.payloadInstallDir, { recursive: true })
  if (plan.arch === 'universal') {
    run([
      'lipo',
      '-create',
      '-output',
      output,
      binaries.get('arm64')!,
      binaries.get('x64')!,
    ])
  } else {
    copyFileSync(binaries.get(plan.arch)!, output)
  }
  chmodSync(output, 0o755)

  const actual = new Set(run(['lipo', '-archs', output], true).split(/\s+/))
  const expected =
    plan.arch === 'universal'
      ? ['arm64', 'x86_64']
      : [plan.arch === 'x64' ? 'x86_64' : 'arm64']
  for (const arch of expected) {
    if (!actual.has(arch)) throw new Error(`standalone is missing ${arch}`)
  }
}

function stageSidecars(plan: ReleasePlan): void {
  const vendor = join(plan.payloadInstallDir, 'vendor')
  cpSync('vendor/computer-use', join(vendor, 'computer-use'), {
    recursive: true,
  })
  for (const dir of selectedArchDirs(plan.arch)) {
    const audio = join('vendor', 'audio-capture', dir, 'audio-capture.node')
    const rg = join('src', 'utils', 'vendor', 'ripgrep', dir, 'rg')
    ensureFiles([audio, rg])
    mkdirSync(join(vendor, 'audio-capture', dir), { recursive: true })
    mkdirSync(join(vendor, 'ripgrep', dir), { recursive: true })
    copyFileSync(
      audio,
      join(vendor, 'audio-capture', dir, 'audio-capture.node'),
    )
    copyFileSync(rg, join(vendor, 'ripgrep', dir, 'rg'))
    chmodSync(join(vendor, 'ripgrep', dir, 'rg'), 0o755)
  }
}

function stageLaunchers(plan: ReleasePlan): void {
  const binDir = join(plan.payloadRoot, 'usr', 'local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const source = renderLauncher(plan.installRoot)
  for (const name of ['ccb', 'claude-code-best']) {
    const path = join(binDir, name)
    writeFileSync(path, source)
    chmodSync(path, 0o755)
  }
}

function signCode(plan: ReleasePlan): void {
  const identity = plan.applicationIdentity ?? '-'
  const order = codeSignOrder(plan.payloadInstallDir, plan.arch)
  ensureFiles(order)
  for (const path of order) {
    const isMain = path === order.at(-1)
    const args = ['codesign', '--force']
    if (plan.sign) args.push('--timestamp')
    if (isMain) {
      args.push('--options', 'runtime', '--entitlements', ENTITLEMENTS)
    }
    args.push('--sign', identity, path)
    run(args)
    run(['codesign', '--verify', '--strict', '--verbose=2', path])
  }
}

function smokePayload(plan: ReleasePlan): void {
  const launcher = join(plan.payloadRoot, 'usr', 'local', 'bin', 'ccb')
  run([join(plan.payloadInstallDir, 'ccb'), '--version'])
  const input = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'macos-release-smoke', version: '1' },
      },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]
    .map(value => JSON.stringify(value))
    .join('\n')
  const proc = Bun.spawnSync({
    cmd: [launcher, '--computer-use-mcp'],
    stdin: Buffer.from(`${input}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CCB_INSTALL_ROOT: plan.payloadInstallDir,
    },
  })
  if (
    proc.exitCode !== 0 ||
    !proc.stdout.toString().includes('computer_batch')
  ) {
    throw new Error(
      `packaged Computer Use MCP smoke failed: ${proc.stderr.toString().trim()}`,
    )
  }
}

function buildPkg(plan: ReleasePlan): void {
  const args = [
    'pkgbuild',
    '--root',
    plan.payloadRoot,
    '--identifier',
    plan.packageIdentifier,
    '--version',
    plan.version,
    '--install-location',
    '/',
  ]
  if (plan.installerIdentity) args.push('--sign', plan.installerIdentity)
  args.push(plan.pkg)
  run(args)

  const payload = run(['pkgutil', '--payload-files', plan.pkg], true)
  const required = [`usr/local/bin/ccb`, 'usr/local/lib/claude-code-best/ccb']
  for (const path of required) {
    if (!payload.includes(path))
      throw new Error(`PKG payload is missing ${path}`)
  }
  if (plan.sign) run(['pkgutil', '--check-signature', plan.pkg])
}

function notarize(path: string, profile: string): void {
  run([
    'xcrun',
    'notarytool',
    'submit',
    path,
    '--keychain-profile',
    profile,
    '--wait',
  ])
  run(['xcrun', 'stapler', 'staple', path])
  run(['xcrun', 'stapler', 'validate', path])
}

function buildDmg(plan: ReleasePlan): void {
  const imageRoot = join(plan.workDir, 'dmg-root')
  mkdirSync(imageRoot, { recursive: true })
  copyFileSync(plan.pkg, join(imageRoot, `${plan.artifactBase}.pkg`))
  writeFileSync(
    join(imageRoot, 'README.txt'),
    `Claude Code Best ${plan.version}\n\nOpen the PKG to install ccb and claude-code-best under /usr/local/bin.\n`,
  )
  run([
    'hdiutil',
    'create',
    '-ov',
    '-format',
    'UDZO',
    '-fs',
    'HFS+',
    '-volname',
    `Claude Code Best ${plan.version}`,
    '-srcfolder',
    imageRoot,
    plan.dmg,
  ])
  if (plan.applicationIdentity) {
    run([
      'codesign',
      '--force',
      '--timestamp',
      '--sign',
      plan.applicationIdentity,
      plan.dmg,
    ])
    run(['codesign', '--verify', '--strict', '--verbose=2', plan.dmg])
  }
  run(['hdiutil', 'verify', plan.dmg])
}

function sha256(path: string): string {
  return run(['shasum', '-a', '256', path], true).split(/\s+/)[0]!
}

function writeReceipt(plan: ReleasePlan): void {
  const artifacts = [plan.pkg, plan.dmg]
  const artifactHashes = Object.fromEntries(
    artifacts.map(path => [relative(plan.outputDir, path), sha256(path)]),
  )
  const commit = run(['git', 'rev-parse', 'HEAD'], true)
  writeFileSync(
    plan.manifest,
    `${JSON.stringify(
      {
        format: 1,
        product: packageJson.name,
        version: plan.version,
        architecture: plan.arch,
        mode: plan.mode,
        notarized: plan.notarize,
        packageIdentifier: plan.packageIdentifier,
        installRoot: plan.installRoot,
        sourceCommit: commit,
        artifacts: artifactHashes,
      },
      null,
      2,
    )}\n`,
  )
  const checksumPaths = [...artifacts, plan.manifest]
  writeFileSync(
    plan.checksums,
    `${checksumPaths
      .map(path => `${sha256(path)}  ${relative(plan.outputDir, path)}`)
      .join('\n')}\n`,
  )
  run(
    ['shasum', '-a', '256', '-c', relative(plan.outputDir, plan.checksums)],
    false,
    plan.outputDir,
  )
}

function validateTrust(plan: ReleasePlan): void {
  if (!plan.notarize) return
  run(['spctl', '--assess', '--type', 'install', '--verbose=4', plan.pkg])
  run(['spctl', '--assess', '--type', 'open', '--verbose=4', plan.dmg])
}

export function parseArgs(args: string[]): ReleaseOptions {
  let arch: ReleaseArch = 'universal'
  let outputDir = DEFAULT_OUTPUT_DIR
  let local = false
  let sign = false
  let notarizeFlag = false
  let planOnly = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--local') local = true
    else if (arg === '--sign') sign = true
    else if (arg === '--notarize') {
      sign = true
      notarizeFlag = true
    } else if (arg === '--plan') planOnly = true
    else if (arg === '--arch') {
      const value = args[++i]
      if (value !== 'universal' && value !== 'arm64' && value !== 'x64') {
        throw new Error('--arch must be universal, arm64, or x64')
      }
      arch = value
    } else if (arg === '--output') {
      const value = args[++i]
      if (!value) throw new Error('--output requires a directory')
      outputDir = value
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: bun run release:macos -- [--local | --sign [--notarize]] [--arch universal|arm64|x64] [--output DIR] [--plan]`,
      )
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (local && sign) throw new Error('--local conflicts with --sign/--notarize')
  return {
    mode: sign ? 'signed' : 'local',
    arch,
    outputDir,
    notarize: notarizeFlag,
    planOnly,
  }
}

function printablePlan(plan: ReleasePlan): object {
  return {
    ...plan,
    applicationIdentity: plan.applicationIdentity ? '<configured>' : undefined,
    installerIdentity: plan.installerIdentity ? '<configured>' : undefined,
    notaryProfile: plan.notaryProfile ? '<configured>' : undefined,
    codeSignOrder: codeSignOrder(plan.payloadInstallDir, plan.arch),
    sequence: [
      ...plan.compileTargets.map(target => `compile ${target}`),
      'lipo standalone executable',
      'stage native sidecars and launchers',
      'sign nested Mach-O code',
      'sign hardened-runtime standalone executable',
      'build PKG',
      ...(plan.notarize ? ['notarize and staple PKG'] : []),
      'build DMG',
      ...(plan.sign ? ['sign DMG'] : []),
      ...(plan.notarize ? ['notarize and staple DMG'] : []),
      'verify artifacts and write checksums',
    ],
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)
  const plan = createReleasePlan(options)
  if (options.planOnly) {
    console.log(JSON.stringify(printablePlan(plan), null, 2))
    console.log('macOS release plan valid')
    return
  }

  ensureDarwin()
  prepareReleaseOutput(plan)
  try {
    const binaries = compileStandalone(plan)
    createStandalone(plan, binaries)
    stageSidecars(plan)
    stageLaunchers(plan)
    signCode(plan)
    smokePayload(plan)
    buildPkg(plan)
    if (plan.notarize) notarize(plan.pkg, plan.notaryProfile!)
    buildDmg(plan)
    if (plan.notarize) notarize(plan.dmg, plan.notaryProfile!)
    validateTrust(plan)
    writeReceipt(plan)
    console.log(`macOS release complete: ${plan.outputDir}`)
  } finally {
    rmSync(plan.workDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
