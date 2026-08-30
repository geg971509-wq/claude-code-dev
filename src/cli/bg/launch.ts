import type { CliLaunchSpec } from '../../utils/cliLaunch.js'

/** Build the platform shell launch used by the reference `--exec` mode. */
export function buildShellLaunch(
  command: string,
  env: NodeJS.ProcessEnv,
): CliLaunchSpec {
  if (process.platform === 'win32') {
    return {
      execPath:
        env.COMSPEC ||
        env.ComSpec ||
        process.env.COMSPEC ||
        process.env.ComSpec ||
        'cmd.exe',
      args: ['/d', '/s', '/c', command],
      env: { ...env },
      windowsHide: true,
    }
  }
  return {
    execPath: env.SHELL || process.env.SHELL || '/bin/sh',
    args: ['-c', command],
    env: { ...env },
    windowsHide: false,
  }
}
