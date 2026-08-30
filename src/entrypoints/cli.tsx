#!/usr/bin/env bun
// Performance shim MUST be the first import — it replaces globalThis.performance
// with a JS-backed implementation before React/OTel capture the native reference.
// Without this, JSC's C++ Vector grows without bound in long-running sessions.
import '../utils/performanceShim.js';
import { feature } from 'bun:bundle';
import { isEnvTruthy } from '../utils/envUtils.js';

// Runtime fallback for MACRO.* when not injected by build/dev defines.
// This happens when running cli.tsx directly (not via `bun run dev` or built dist/).
if (typeof globalThis.MACRO === 'undefined') {
  (globalThis as any).MACRO = {
    VERSION: process.env.CLAUDE_CODE_VERSION || '2.1.888',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '',
    VERSION_CHANGELOG: '',
  };
}

if (isEnvTruthy(process.env.CLAUDE_CODE_FORCE_INTERACTIVE)) {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    if (!stream.isTTY) {
      try {
        Object.defineProperty(stream, 'isTTY', {
          value: true,
          configurable: true,
        });
      } catch {
        // Best-effort dev-only override for nested bun launch on Windows.
      }
    }
  }
}

// Bugfix for corepack auto-pinning, which adds yarnpkg to peoples' package.jsons
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// Prevent Windows from resolving executables from the current directory.
// This must be set before any fast-path can spawn a child process.
process.env.NoDefaultCurrentDirectoryInExePath = '1';

// Set max heap size for child processes in CCR environments (containers have 16GB)
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  const existing = process.env.NODE_OPTIONS || '';
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late. feature() gate
// DCEs this entire block from external builds.
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_DISABLE_THINKING',
    'DISABLE_INTERLEAVED_THINKING',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  ]) {
    process.env[k] ??= '1';
  }
}

/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Fast-path for --version/-v: zero module loading needed. The official CLI
  // accepts `--verbose` as a second argument and prints the build commit.
  if (
    (args.length === 1 || (args.length === 2 && args[1] === '--verbose')) &&
    (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')
  ) {
    // MACRO.VERSION is inlined at build time
    console.log(`${MACRO.VERSION} (Claude Code)`);
    if (args.length === 2) {
      const commit = process.env.CLAUDE_CODE_GIT_SHA;
      if (commit) console.log(`Commit: ${commit}`);
    }
    return;
  }

  if (process.env.CLAUDE_CODE_MEMORY_DEBUG === '1') {
    const { startMemoryDebugMonitor } = await import('../utils/memoryDebug.js');
    startMemoryDebugMonitor();
  }

  if (args[0] === '--bg-pty-host') {
    const configPath = args[1];
    if (!configPath) throw new Error('--bg-pty-host requires a config path.');
    try {
      await ensureFastPathSettingsLoaded();
    } catch (error) {
      // The supervisor already performed its policy check. A settings read
      // failure must not strand the PTY host before it can acknowledge exit.
      process.stderr.write(
        `ptyHost: settings bootstrap threw (continuing; supervisor already gated): ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }\n`,
      );
    }
    const { runPtyHostFromConfig } = await import('../cli/bg/ptyHost.js');
    process.exitCode = await runPtyHostFromConfig(configPath);
    return;
  }

  const agentsNeedsFullSettings = args.some(
    arg =>
      arg === '--settings' ||
      arg.startsWith('--settings=') ||
      arg === '--setting-sources' ||
      arg.startsWith('--setting-sources='),
  );
  if (args[0] === 'agents' && !agentsNeedsFullSettings) {
    const { agentsCliMain } = await import('../cli/handlers/agents.js');
    await agentsCliMain(args.slice(1));
    return;
  }

  // For all other paths, load the startup profiler
  const { profileCheckpoint } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // Fast-path for --dump-system-prompt: output the rendered system prompt and exit.
  // Used by prompt sensitivity evals to extract the system prompt at a specific commit.
  // Ant-only: eliminated from external builds via feature flag.
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { getMainLoopModel } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel();
    const { getSystemPrompt } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    console.log(prompt.join('\n'));
    return;
  }

  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const { runClaudeInChromeMcpServer } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const { runChromeNativeHost } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const { runComputerUseMcpServer } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // Fast-path for `--acp` — ACP (Agent Client Protocol) agent mode over stdio.
  if (feature('ACP') && process.argv[2] === '--acp') {
    profileCheckpoint('cli_acp_path');
    const { runAcpAgent } = await import('../services/acp/entry.js');
    await runAcpAgent();
    return;
  }

  if (args[0] === 'weixin') {
    profileCheckpoint('cli_weixin_path');
    const { handleWeixinCli } = await import('@claude-code-best/weixin');
    const { enableConfigs } = await import('../utils/config.js');
    const { initializeAnalyticsSink } = await import('../services/analytics/sink.js');
    const { shutdownDatadog } = await import('../services/analytics/datadog.js');
    const { shutdown1PEventLogging } = await import('../services/analytics/firstPartyEventLogger.js');
    const { logForDebugging } = await import('../utils/debug.js');
    const { ChannelPermissionRequestNotificationSchema } = await import('../services/mcp/channelNotification.js');
    await handleWeixinCli(
      args.slice(1),
      {
        enableConfigs,
        initializeAnalyticsSink,
        shutdownDatadog,
        shutdown1PEventLogging,
        logForDebugging,
        registerPermissionHandler(server, handler) {
          server.setNotificationHandler(ChannelPermissionRequestNotificationSchema(), async notification =>
            handler(notification.params),
          );
        },
      },
      MACRO.VERSION,
    );
    return;
  }

  // Fast-path for `--daemon-worker=<kind>` (internal — supervisor spawns this).
  // Must come before the daemon subcommand check: spawned per-worker, so
  // perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
  // workers are lean. If a worker kind needs configs/auth (assistant will),
  // it calls them inside its run() fn.
  if (args[0] === '--daemon-worker' || args[0]?.startsWith('--daemon-worker=')) {
    await ensureFastPathSettingsLoaded();
    const kind = args[0] === '--daemon-worker' ? args[1] : args[0].split('=')[1];
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(kind);
    return;
  }

  // Fast-path for `claude remote-control` (also accepts legacy `claude remote` / `claude sync` / `claude bridge`):
  // serve local machine as bridge environment.
  // feature() must stay inline for build-time dead code elimination;
  // isBridgeEnabled() checks the runtime GrowthBook gate.
  if (
    feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' ||
      args[0] === 'rc' ||
      args[0] === 'remote' ||
      args[0] === 'sync' ||
      args[0] === 'bridge')
  ) {
    profileCheckpoint('cli_bridge_path');
    await ensureFastPathSettingsLoaded();
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();

    const { getBridgeDisabledReason, checkBridgeMinVersion } = await import('../bridge/bridgeEnabled.js');
    const { BRIDGE_LOGIN_ERROR } = await import('../bridge/types.js');
    const { bridgeMain } = await import('../bridge/bridgeMain.js');
    const { exitWithError } = await import('../utils/process.js');

    // Auth check must come before the GrowthBook gate check — without auth,
    // GrowthBook has no user context and would return a stale/default false.
    // getBridgeDisabledReason awaits GB init, so the returned value is fresh
    // (not the stale disk cache), but init still needs auth headers to work.
    const { getClaudeAIOAuthTokens } = await import('../utils/auth.js');
    const { getBridgeAccessToken } = await import('../bridge/bridgeConfig.js');
    if (!getClaudeAIOAuthTokens()?.accessToken && !getBridgeAccessToken()) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // Bridge is a remote control feature - check policy limits
    const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }

    await bridgeMain(args.slice(1));
    return;
  }

  // Fast-path for `claude daemon [subcommand]`: unified daemon + session management.
  // Handles both supervisor (start/stop) and background session (bg/attach/logs/kill)
  // subcommands under one namespace.
  if ((feature('DAEMON') || feature('BG_SESSIONS')) && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    await ensureFastPathSettingsLoaded();
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // Fast-path for `claude autonomy ...`: state inspection/management commands
  // do not need the full interactive CLI bootstrap. The full Commander path
  // imports main.tsx and runs root preAction initialization before the autonomy
  // action; under coverage/CI that leaves unrelated handles around simple
  // state-only subprocess calls.
  if (args[0] === 'autonomy') {
    profileCheckpoint('cli_autonomy_path');
    const { getAutonomyCommandText } = await import('../cli/handlers/autonomy.js');
    const text = await getAutonomyCommandText(args.slice(1).join(' '));
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  }

  // Fast-path for `--bg`/`--background` shortcut → daemon bg.
  if (feature('BG_SESSIONS') && (args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_daemon_path');
    await ensureFastPathSettingsLoaded();
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const bg = await import('../cli/bg.js');
    await bg.handleBgStart(args.filter(a => a !== '--bg' && a !== '--background'));
    return;
  }

  // `claude stop <id>` is the reference CLI's graceful background-session
  // shortcut; daemon stop remains reserved for the supervisor.
  if (feature('BG_SESSIONS') && args[0] === 'stop') {
    profileCheckpoint('cli_daemon_path');
    await ensureFastPathSettingsLoaded();
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    await bg.stopHandler(args[1]);
    return;
  }

  // Backward-compat: ps/logs/attach/kill → daemon <sub> (deprecated).
  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' ||
      args[0] === 'logs' ||
      args[0] === 'attach' ||
      args[0] === 'kill')
  ) {
    const mapped = args[0] === 'ps' ? 'status' : args[0];
    console.error(`[deprecated] Use: claude daemon ${mapped}${args[1] ? ' ' + args[1] : ''}`);
    profileCheckpoint('cli_daemon_path');
    await ensureFastPathSettingsLoaded();
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain([args[0] === 'ps' ? 'status' : args[0]!, ...args.slice(1)]);
    return;
  }

  // Fast-path for `claude job <subcommand>`: template jobs.
  if (feature('TEMPLATES') && args[0] === 'job') {
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args.slice(1));
    // process.exit (not return) — mountFleetView's Ink TUI can leave event
    // loop handles that prevent natural exit.
    process.exit(0);
  }

  // Backward-compat: new/list/reply → job <sub> (deprecated)
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    console.error(`[deprecated] Use: claude job ${args[0]} ${args.slice(1).join(' ')}`.trim());
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    process.exit(0);
  }

  // Fast-path for --worktree --tmux: exec into tmux before loading full CLI
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (
    hasTmuxFlag &&
    (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { isWorktreeModeEnabled } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const { execIntoTmuxWorktree } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // If not handled (e.g., error), fall through to normal CLI
      if (result.error) {
        const { exitWithError } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: set SIMPLE early so gates fire during module eval / commander
  // option building (not just inside the action handler).
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // No special flags detected, load and run the full CLI. Only the official
  // NON_REPL_SUBCOMMANDS set bypasses early input capture; other commands may
  // still be interactive even when they have a subcommand-shaped argv.
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
  const nonReplSubcommands = new Set(['update', 'upgrade', 'doctor']);
  const mcpIndex = args.indexOf('mcp');
  const isMcpServe = mcpIndex !== -1 && args[mcpIndex + 1] === 'serve';
  if (!nonReplSubcommands.has(args[0] ?? '') && !isMcpServe) {
    startCapturingEarlyInput();
  }
  profileCheckpoint('cli_before_main_import');
  const { main: cliMain } = await import('../main.tsx');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

/**
 * Start the same policy/settings prefetch used by the official internal
 * fast paths. The normal REPL gets this from main.tsx module evaluation; the
 * lightweight daemon/PTY paths bypass that module and must explicitly load it.
 */
async function ensureFastPathSettingsLoaded(): Promise<void> {
  const [{ startMdmRawRead }, mdm, keychain] = await Promise.all([
    import('../utils/settings/mdm/rawRead.js'),
    import('../utils/settings/mdm/settings.js'),
    import('../utils/secureStorage/keychainPrefetch.js'),
  ]);
  startMdmRawRead();
  keychain.startKeychainPrefetch();
  mdm.startMdmSettingsLoad();
  await Promise.all([
    mdm.ensureMdmSettingsLoaded(),
    keychain.ensureKeychainPrefetchCompleted(),
  ]);
}

await main();
