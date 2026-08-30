import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseShellWords } from 'shell-quote'
import { z } from 'zod'

const PROJECT_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_OFFICIAL = [
  'bun',
  '/Volumes/work/software/install/claude-official/modules/src/entrypoints/baseline/cli.js',
]
const DEFAULT_CANDIDATE = ['bun', 'scripts/dev.ts']
const PROCESS_TIMEOUT_MS = 30_000
const jsonSchema = z.json()

type JsonValue = z.infer<typeof jsonSchema>
type JsonObject = { [key: string]: JsonValue }
type NormalizeContext = { tempRoot?: string; port?: number }
type CapturedRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: JsonValue | null
}
type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}
type ScenarioKind =
  | 'text'
  | 'json'
  | 'stream-json'
  | 'error'
  | 'read'
  | 'dynamic-prompt'
type RunResult = ProcessResult & {
  requests: CapturedRequest[]
  tempRoot: string
  port: number
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseLaunchSpec(spec: string): string[] {
  const entries = parseShellWords(spec)
  if (entries.some(entry => typeof entry !== 'string')) {
    throw new Error('shell operators are not allowed in launch specs')
  }
  const argv = entries.filter(entry => typeof entry === 'string')
  if (argv.length === 0) throw new Error('launch spec must not be empty')
  return argv
}

function normalizeString(value: string, context: NormalizeContext): string {
  let result = value
  if (context.tempRoot) result = result.replaceAll(context.tempRoot, '<TMP>')
  if (context.port !== undefined) {
    result = result.replaceAll(`127.0.0.1:${context.port}`, '127.0.0.1:<PORT>')
    result = result.replaceAll(`localhost:${context.port}`, 'localhost:<PORT>')
  }
  result = result.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    '<ID>',
  )
  result = result.replace(/\b(?:msg|toolu|req)_[A-Za-z0-9_-]+\b/g, '<ID>')
  result = result.replace(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g,
    '<TIMESTAMP>',
  )
  return result
}

function isTimingKey(key: string): boolean {
  return (
    /(?:^|_)(?:duration|elapsed|latency|timing|ttft)(?:_|$)/i.test(key) ||
    /_ms$/i.test(key)
  )
}

function isIdKey(key: string): boolean {
  return /(?:^|_)(?:id|uuid)$|^(?:id|uuid)$/i.test(key)
}

export function normalizeValue(
  value: JsonValue,
  context: NormalizeContext = {},
  key = '',
): JsonValue {
  if (isTimingKey(key) && typeof value === 'number') return '<TIMING>'
  if (isIdKey(key) && typeof value === 'string') return '<ID>'
  if (typeof value === 'string') return normalizeString(value, context)
  if (Array.isArray(value)) {
    return value.map(item => normalizeValue(item, context))
  }
  if (!isJsonObject(value)) return value
  const normalized: JsonObject = {}
  for (const currentKey of Object.keys(value).sort()) {
    normalized[currentKey] = normalizeValue(
      value[currentKey],
      context,
      currentKey,
    )
  }
  return normalized
}

function headerValue(
  headers: IncomingHttpHeaders | Record<string, string>,
  name: string,
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value.join(',') : value
}

export function projectRequest(
  request: CapturedRequest,
  context: NormalizeContext,
): JsonValue {
  const headers: Record<string, JsonValue> = {}
  for (const name of ['anthropic-beta', 'anthropic-version', 'x-api-key']) {
    const value = headerValue(request.headers, name)
    if (value !== undefined) {
      headers[name] = name === 'x-api-key' ? '<present>' : value
    }
  }
  const body = request.body
  const projectedBody: JsonObject = {}
  if (isJsonObject(body)) {
    for (const key of [
      'model',
      'max_tokens',
      'max_tokens_to_sample',
      'temperature',
      'top_p',
      'top_k',
      'stream',
      'output_config',
      'context_management',
    ]) {
      if (body[key] !== undefined)
        projectedBody[key] = normalizeValue(body[key], context, key)
    }
    if (isJsonObject(body.thinking)) {
      const thinking = body.thinking
      projectedBody.thinking = normalizeValue(
        Object.fromEntries(
          ['type', 'budget_tokens', 'effort'].flatMap(key =>
            thinking[key] === undefined ? [] : [[key, thinking[key]]],
          ),
        ),
        context,
      )
    }
    if (Array.isArray(body.tools)) {
      projectedBody.tools = body.tools.map(tool => {
        if (!isJsonObject(tool)) return tool
        return {
          name: tool.name,
          input_schema: normalizeValue(tool.input_schema, context),
        }
      })
    }
    if (Array.isArray(body.messages)) {
      projectedBody.messages = body.messages.map(message => {
        if (!isJsonObject(message)) return message
        return {
          role: message.role,
          content: normalizeValue(message.content, context),
        }
      })
    }
  }
  return {
    method: request.method,
    path: normalizeString(request.path, context),
    headers,
    body: request.body === null ? null : projectedBody,
  }
}

function projectResult(value: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const key of [
    'type',
    'subtype',
    'is_error',
    'result',
    'structured_output',
    'terminal_reason',
    'api_error_status',
    'fast_mode_disabled_reason',
    'stop_reason',
    'num_turns',
    'permission_denials',
  ]) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  if (isJsonObject(value.usage)) {
    result.usage = {
      input_tokens: value.usage.input_tokens,
      output_tokens: value.usage.output_tokens,
      output_tokens_details: value.usage.output_tokens_details,
    }
  }
  if (isJsonObject(value.modelUsage)) {
    result.modelUsage = Object.fromEntries(
      Object.entries(value.modelUsage).map(([model, usage]) => [
        model,
        isJsonObject(usage)
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
              costUSD: usage.costUSD,
              contextWindow: usage.contextWindow,
              maxOutputTokens: usage.maxOutputTokens,
              canonicalModel: usage.canonicalModel,
              provider: usage.provider,
            }
          : usage,
      ]),
    )
  }
  return result
}

function projectOutput(
  kind: ScenarioKind,
  output: JsonValue,
  context: NormalizeContext,
): JsonValue {
  if (kind === 'stream-json' && Array.isArray(output)) {
    return output
      .filter(item => isJsonObject(item) && item.type === 'result')
      .map(item => normalizeValue(projectResult(item as JsonObject), context))
  }
  if (isJsonObject(output))
    return normalizeValue(projectResult(output), context)
  return output
}

export function extractHelpOptions(help: string): Set<string> {
  const options = new Set<string>()
  for (const match of help.matchAll(/(?:^|\n)\s+(?:-[\w?],\s+)?(--[\w-]+)/g)) {
    const option = match[1]
    if (option) options.add(option)
  }
  return options
}

function printable(value: JsonValue | undefined): string {
  if (value === undefined) return '<missing>'
  const encoded = JSON.stringify(value)
  return encoded.length <= 1_200 ? encoded : `${encoded.slice(0, 1_197)}...`
}

export function diffValues(
  official: JsonValue | undefined,
  candidate: JsonValue | undefined,
  path = '$',
  differences: string[] = [],
): string[] {
  if (differences.length >= 100) return differences
  if (Object.is(official, candidate)) return differences
  if (Array.isArray(official) && Array.isArray(candidate)) {
    const length = Math.max(official.length, candidate.length)
    for (let index = 0; index < length; index++) {
      diffValues(
        official[index],
        candidate[index],
        `${path}[${index}]`,
        differences,
      )
    }
    return differences
  }
  if (
    official !== undefined &&
    candidate !== undefined &&
    isJsonObject(official) &&
    isJsonObject(candidate)
  ) {
    const keys = new Set([...Object.keys(official), ...Object.keys(candidate)])
    for (const key of [...keys].sort()) {
      diffValues(official[key], candidate[key], `${path}.${key}`, differences)
    }
    return differences
  }
  if (typeof official === 'string' && typeof candidate === 'string') {
    let index = 0
    const limit = Math.min(official.length, candidate.length)
    while (index < limit && official[index] === candidate[index]) index++
    const start = Math.max(0, index - 160)
    differences.push(
      `${path}@${index}: official=${printable(official.slice(start, index + 320))} candidate=${printable(candidate.slice(start, index + 320))}`,
    )
    return differences
  }
  differences.push(
    `${path}: official=${printable(official)} candidate=${printable(candidate)}`,
  )
  return differences
}

function sse(events: JsonValue[]): string {
  return `${events.map(event => `event: ${isJsonObject(event) && typeof event.type === 'string' ? event.type : 'message'}\ndata: ${JSON.stringify(event)}\n`).join('\n')}\n`
}

function textResponse(text: string): string {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ])
}

function toolResponse(filePath: string): string {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_tool_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_fixture',
        name: 'Read',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ file_path: filePath }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: 'message_stop' },
  ])
}

function collectHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const collected: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      collected[name.toLowerCase()] = headerValue(headers, name) ?? ''
  }
  return collected
}

function safeEnvironment(
  tempRoot: string,
  port: number,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of [
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'BUN_INSTALL',
    'NODE_PATH',
  ]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  const baseUrl = `http://127.0.0.1:${port}`
  return {
    ...environment,
    HOME: join(tempRoot, 'home'),
    XDG_CONFIG_HOME: join(tempRoot, 'xdg'),
    CLAUDE_CONFIG_DIR: join(tempRoot, 'claude'),
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: baseUrl,
    HTTP_PROXY: baseUrl,
    HTTPS_PROXY: baseUrl,
    ALL_PROXY: baseUrl,
    NO_PROXY: '127.0.0.1,localhost',
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    OTEL_SDK_DISABLED: 'true',
  }
}

async function runProcess(
  launch: string[],
  args: string[],
  environment: Record<string, string>,
): Promise<ProcessResult> {
  const proc = Bun.spawn({
    cmd: [...launch, ...args],
    cwd: PROJECT_ROOT,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGTERM')
    forceTimer = setTimeout(() => proc.kill('SIGKILL'), 2_000)
  }, PROCESS_TIMEOUT_MS)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    if (forceTimer) clearTimeout(forceTimer)
  }
}

async function runProviderScenario(
  launch: string[],
  kind: ScenarioKind,
  root: string,
  label: string,
): Promise<RunResult> {
  const tempRoot = join(root, `${kind}-${label}`)
  mkdirSync(join(tempRoot, 'home'), { recursive: true })
  mkdirSync(join(tempRoot, 'xdg'), { recursive: true })
  mkdirSync(join(tempRoot, 'claude'), { recursive: true })
  const requests: CapturedRequest[] = []
  let messageRequestCount = 0
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let body: JsonValue | null = null
    if (rawBody) {
      const parsed = jsonSchema.safeParse(JSON.parse(rawBody))
      body = parsed.success ? parsed.data : rawBody
    }
    const path = request.url ?? '/'
    requests.push({
      method: request.method ?? 'GET',
      path,
      headers: collectHeaders(request.headers),
      body,
    })
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end()
      return
    }
    if (!path.startsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'unexpected fixture path' } }),
      )
      return
    }
    messageRequestCount++
    if (kind === 'error') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'FIXTURE_BAD_REQUEST',
          },
        }),
      )
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      kind === 'read' && messageRequestCount === 1
        ? toolResponse(join(PROJECT_ROOT, 'package.json'))
        : textResponse(kind === 'read' ? 'TOOL_OK' : 'LOCAL_OK'),
    )
  })
  await new Promise<void>((resolveReady, rejectReady) => {
    server.once('error', rejectReady)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server did not expose a TCP port')
  }
  const common = [
    '--bare',
    '--no-session-persistence',
    '--model',
    'claude-sonnet-4-6',
    ...(kind === 'dynamic-prompt'
      ? ['--exclude-dynamic-system-prompt-sections']
      : []),
  ]
  const args =
    kind === 'read'
      ? [
          ...common,
          '--tools',
          'Read',
          '--dangerously-skip-permissions',
          '--output-format',
          'json',
          '-p',
          'Read package',
        ]
      : [
          ...common,
          '--tools',
          '',
          ...(kind === 'json' || kind === 'error' || kind === 'dynamic-prompt'
            ? ['--output-format', 'json']
            : kind === 'stream-json'
              ? ['--output-format', 'stream-json', '--verbose']
              : []),
          '-p',
          kind === 'error' ? 'Trigger error' : 'Say hello',
        ]
  try {
    const result = await runProcess(
      launch,
      args,
      safeEnvironment(tempRoot, address.port),
    )
    return { ...result, requests, tempRoot, port: address.port }
  } finally {
    await new Promise<void>(resolveClosed =>
      server.close(() => resolveClosed()),
    )
  }
}

function parseOutput(
  kind: ScenarioKind,
  output: string,
  context: NormalizeContext,
): JsonValue {
  const trimmed = output.trimEnd()
  if (kind === 'text') return normalizeString(trimmed, context)
  if (kind === 'stream-json') {
    return trimmed
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parsed = jsonSchema.safeParse(JSON.parse(line))
        return parsed.success ? normalizeValue(parsed.data, context) : line
      })
  }
  const parsed = jsonSchema.safeParse(JSON.parse(trimmed))
  return parsed.success ? normalizeValue(parsed.data, context) : trimmed
}

function projectRun(kind: ScenarioKind, run: RunResult): JsonValue {
  const context = { tempRoot: run.tempRoot, port: run.port }
  const parsedOutput = parseOutput(kind, run.stdout, context)
  return {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    stdout: projectOutput(kind, parsedOutput, context),
    stderr: normalizeString(
      run.stderr
        .replace(
          '[ripgrep] fallback: builtin rg unavailable on darwin, using system rg',
          '',
        )
        .trimEnd(),
      context,
    ),
    requests: run.requests.map(request => projectRequest(request, context)),
  }
}

function parseArguments(args: string[]): {
  official: string[]
  candidate: string[]
} {
  let official = DEFAULT_OFFICIAL
  let candidate = DEFAULT_CANDIDATE
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg?.startsWith('--official='))
      official = parseLaunchSpec(arg.slice(11))
    else if (arg?.startsWith('--candidate='))
      candidate = parseLaunchSpec(arg.slice(12))
    else if (arg === '--official' || arg === '--candidate') {
      const spec = args[++index]
      if (!spec) throw new Error(`${arg} requires a launch spec`)
      if (arg === '--official') official = parseLaunchSpec(spec)
      else candidate = parseLaunchSpec(spec)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return { official, candidate }
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const { official, candidate } = parseArguments(args)
  const root = mkdtempSync(join(tmpdir(), 'claude-parity-'))
  const mismatches: string[] = []
  try {
    const cliEnvironment = safeEnvironment(join(root, 'cli'), 9)
    for (const directory of ['home', 'xdg', 'claude']) {
      mkdirSync(join(root, 'cli', directory), { recursive: true })
    }
    const [officialHelp, candidateHelp] = await Promise.all([
      runProcess(official, ['--help'], cliEnvironment),
      runProcess(candidate, ['--help'], cliEnvironment),
    ])
    if (officialHelp.exitCode !== candidateHelp.exitCode) {
      mismatches.push(
        `help exit status: official=${officialHelp.exitCode} candidate=${candidateHelp.exitCode}`,
      )
    }
    const requiredOptions = extractHelpOptions(officialHelp.stdout)
    const candidateOptions = extractHelpOptions(candidateHelp.stdout)
    for (const option of [...requiredOptions].sort()) {
      if (!candidateOptions.has(option))
        mismatches.push(`help missing official option ${option}`)
    }

    const [officialInvalid, candidateInvalid] = await Promise.all([
      runProcess(official, ['--definitely-invalid-option'], cliEnvironment),
      runProcess(candidate, ['--definitely-invalid-option'], cliEnvironment),
    ])
    if (officialInvalid.exitCode !== candidateInvalid.exitCode) {
      mismatches.push(
        `invalid-option exit status: official=${officialInvalid.exitCode} candidate=${candidateInvalid.exitCode}`,
      )
    }
    for (const [label, result] of [
      ['official', officialInvalid],
      ['candidate', candidateInvalid],
    ] as const) {
      if (
        !/definitely-invalid-option/.test(`${result.stdout}\n${result.stderr}`)
      ) {
        mismatches.push(
          `${label} invalid-option output did not name the option`,
        )
      }
    }

    for (const kind of [
      'text',
      'json',
      'stream-json',
      'error',
      'read',
      'dynamic-prompt',
    ] as const) {
      const officialRun = await runProviderScenario(
        official,
        kind,
        root,
        'official',
      )
      const candidateRun = await runProviderScenario(
        candidate,
        kind,
        root,
        'candidate',
      )
      const differences = diffValues(
        projectRun(kind, officialRun),
        projectRun(kind, candidateRun),
      )
      for (const difference of differences)
        mismatches.push(`${kind} ${difference}`)
      for (const [label, run] of [
        ['official', officialRun],
        ['candidate', candidateRun],
      ] as const) {
        const unexpected = run.requests.filter(
          request =>
            !request.path.startsWith('/v1/messages') &&
            request.path !== '/api/hello',
        )
        if (unexpected.length > 0) {
          mismatches.push(
            `${kind} ${label} emitted unexpected non-provider requests: ${unexpected.map(request => `${request.method} ${request.path}`).join(', ')}`,
          )
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  if (mismatches.length > 0) {
    console.error(`Claude runtime parity mismatch (${mismatches.length})`)
    for (const mismatch of mismatches.slice(0, 200))
      console.error(`- ${mismatch}`)
    if (mismatches.length > 200) {
      console.error(
        `- ... ${mismatches.length - 200} additional mismatches omitted`,
      )
    }
    process.exitCode = 1
    return
  }
  console.log('Claude runtime parity verified')
}

if (import.meta.main) {
  await main()
}
