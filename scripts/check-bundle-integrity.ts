#!/usr/bin/env bun
/**
 * Validate the built dist/ tree rather than source modules.
 *
 * Checks:
 * - relative static/dynamic JS imports resolve inside dist/
 * - runtime imports are Node builtins, declared runtime dependencies, or
 *   explicitly optional integrations
 * - Bun-only imports are surfaced as warnings for the dual Node/Bun build
 */
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(
  await readFile(join(scriptDir, '..', 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const RUNTIME_DEPS = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
])
const NODE_BUILTINS = new Set(
  builtinModules.map(name => name.replace(/^node:/, '')),
)
const BUN_MODULES = new Set(['bun', 'bun:ffi', 'bun:test', 'bun:sqlite'])
const OPTIONAL_RUNTIME_MODULES = new Set(['@napi-rs/keyring'])
const NATIVE_FRAMEWORKS = new Set([
  'AppKit',
  'CoreGraphics',
  'Foundation',
  'UIKit',
])

const STATIC_IMPORT_RE =
  /(?:from\s+|import\s*)["']((?:\.\.?\/)[^"']+\.js)["']/g
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g
const REQUIRE_RE = /__require\(\s*["']([^"']+)["']\s*\)/g
const NODE_REQUIRE_RE = /nodeRequire\(\s*["']([^"']+)["']\s*\)/g

type FindingType =
  | 'broken-js-ref'
  | 'third-party-require'
  | 'third-party-import'
  | 'third-party-node-require'
  | 'bun-runtime-only'

type Finding = {
  type: FindingType
  severity: 'error' | 'warning'
  file: string
  line: number
  module: string
  snippet: string
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

async function collectJsFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(root, absolute)))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(normalizePath(relative(root, absolute)))
    }
  }
  return files.sort()
}

function packageRoot(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier
  const [scope, name] = specifier.split('/')
  return name ? `${scope}/${name}` : specifier
}

function isAllowedRuntimeModule(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  if (NODE_BUILTINS.has(specifier)) return true
  if (NODE_BUILTINS.has(packageRoot(specifier))) return true
  if (RUNTIME_DEPS.has(packageRoot(specifier))) return true
  if (OPTIONAL_RUNTIME_MODULES.has(packageRoot(specifier))) return true
  if (NATIVE_FRAMEWORKS.has(specifier)) return true
  return false
}

function isBunModule(specifier: string): boolean {
  return BUN_MODULES.has(specifier)
}

function resolveRelativeRef(
  distDir: string,
  fromFile: string,
  specifier: string,
): string {
  const absolute = resolve(distDir, dirname(fromFile), specifier)
  return normalizePath(relative(distDir, absolute))
}

function pushFinding(
  findings: Finding[],
  finding: Omit<Finding, 'snippet'>,
  sourceLine: string,
): void {
  findings.push({ ...finding, snippet: sourceLine.trim().slice(0, 120) })
}

function resetMatches(line: string, pattern: RegExp): IterableIterator<RegExpMatchArray> {
  pattern.lastIndex = 0
  return line.matchAll(pattern)
}

function groupByModule(items: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>()
  for (const item of items) {
    const group = grouped.get(item.module) ?? []
    group.push(item)
    grouped.set(item.module, group)
  }
  return new Map(
    [...grouped.entries()].sort((left, right) => right[1].length - left[1].length),
  )
}

async function main(): Promise<void> {
  const distDir = resolve(process.argv[2] || './dist')
  let files: string[]
  try {
    files = await collectJsFiles(distDir)
  } catch {
    console.error(`Cannot read build output: ${distDir}`)
    console.error('Run "bun run build:vite" first.')
    process.exit(1)
  }

  if (files.length === 0) {
    console.error(`No JavaScript build output found in ${distDir}`)
    process.exit(1)
  }

  const fileSet = new Set(files)
  const findings: Finding[] = []
  console.log(`Checking ${files.length} JavaScript files in ${distDir}`)

  for (const file of files) {
    const content = await readFile(join(distDir, file), 'utf8')
    const lines = content.split('\n')

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      const lineNumber = index + 1

      for (const match of resetMatches(line, STATIC_IMPORT_RE)) {
        const specifier = match[1]
        if (!specifier) continue
        const target = resolveRelativeRef(distDir, file, specifier)
        if (target.startsWith('../') || !fileSet.has(target)) {
          pushFinding(
            findings,
            {
              type: 'broken-js-ref',
              severity: 'error',
              file,
              line: lineNumber,
              module: specifier,
            },
            line,
          )
        }
      }

      for (const match of resetMatches(line, DYNAMIC_IMPORT_RE)) {
        const specifier = match[1]
        if (!specifier) continue
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          if (specifier.endsWith('.js')) {
            const target = resolveRelativeRef(distDir, file, specifier)
            if (target.startsWith('../') || !fileSet.has(target)) {
              pushFinding(
                findings,
                {
                  type: 'broken-js-ref',
                  severity: 'error',
                  file,
                  line: lineNumber,
                  module: specifier,
                },
                line,
              )
            }
          }
          continue
        }
        if (isBunModule(specifier)) {
          pushFinding(
            findings,
            {
              type: 'bun-runtime-only',
              severity: 'warning',
              file,
              line: lineNumber,
              module: specifier,
            },
            line,
          )
        } else if (!isAllowedRuntimeModule(specifier)) {
          pushFinding(
            findings,
            {
              type: 'third-party-import',
              severity: 'error',
              file,
              line: lineNumber,
              module: specifier,
            },
            line,
          )
        }
      }

      for (const [pattern, type] of [
        [REQUIRE_RE, 'third-party-require'],
        [NODE_REQUIRE_RE, 'third-party-node-require'],
      ] as const) {
        for (const match of resetMatches(line, pattern)) {
          const specifier = match[1]
          if (!specifier) continue
          if (isBunModule(specifier)) {
            pushFinding(
              findings,
              {
                type: 'bun-runtime-only',
                severity: 'warning',
                file,
                line: lineNumber,
                module: specifier,
              },
              line,
            )
          } else if (!isAllowedRuntimeModule(specifier)) {
            pushFinding(
              findings,
              {
                type,
                severity: 'error',
                file,
                line: lineNumber,
                module: specifier,
              },
              line,
            )
          }
        }
      }
    }
  }

  const errors = findings.filter(item => item.severity === 'error')
  const warnings = findings.filter(item => item.severity === 'warning')

  for (const type of [
    'broken-js-ref',
    'third-party-require',
    'third-party-import',
    'third-party-node-require',
    'bun-runtime-only',
  ] as const) {
    const items = findings.filter(item => item.type === type)
    if (items.length === 0) continue
    console.log(`\n${type}: ${items.length}`)
    for (const [module, moduleItems] of groupByModule(items)) {
      console.log(`  ${module} (${moduleItems.length})`)
      for (const item of moduleItems.slice(0, 5)) {
        console.log(`    ${item.file}:${item.line}`)
      }
      if (moduleItems.length > 5) {
        console.log(`    ... ${moduleItems.length - 5} more`)
      }
    }
  }

  console.log(
    `\nBundle integrity: ${errors.length} error(s), ${warnings.length} warning(s)`,
  )
  if (errors.length > 0) process.exit(1)
}

main().catch(error => {
  console.error('Bundle integrity check failed:', error)
  process.exit(2)
})
