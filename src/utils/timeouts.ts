// Constants for timeout values
const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
const MAX_TIMEOUT_MS = 600_000 // 10 minutes
const DEFAULT_API_TIMEOUT_MS = 600_000 // 10 minutes

type EnvLike = Record<string, string | undefined>

/**
 * Get the default timeout for bash operations in milliseconds
 * Checks BASH_DEFAULT_TIMEOUT_MS environment variable or returns 2 minutes default
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getDefaultBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_DEFAULT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * Get the maximum timeout for bash operations in milliseconds
 * Checks BASH_MAX_TIMEOUT_MS environment variable or returns 10 minutes default
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getMaxBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_MAX_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      // Ensure max is at least as large as default
      return Math.max(parsed, getDefaultBashTimeoutMs(env))
    }
  }
  // Always ensure max is at least as large as default
  return Math.max(MAX_TIMEOUT_MS, getDefaultBashTimeoutMs(env))
}

/**
 * Get the API request timeout in milliseconds
 * Checks API_TIMEOUT_MS environment variable or returns 10 minutes default.
 * Invalid values (non-numeric, non-positive) fall back to the default —
 * a NaN timeout would fire immediately and fail every request.
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getApiTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.API_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_API_TIMEOUT_MS
}
