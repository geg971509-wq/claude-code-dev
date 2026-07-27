/**
 * Global registry for cleanup functions that should run during graceful shutdown.
 * This module is separate from gracefulShutdown.ts to avoid circular dependencies.
 */

// Global registry for cleanup functions
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * Register a cleanup function to run during graceful shutdown.
 * @param cleanupFn - Function to run during cleanup (can be sync or async)
 * @returns Unregister function that removes the cleanup handler
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // Return unregister function
}

/**
 * Run all registered cleanup functions.
 * Used internally by gracefulShutdown.
 *
 * Uses Promise.allSettled to guarantee all cleanup functions execute even if
 * some fail. Critical cleanups (session persistence, MCP connections, temp files)
 * must complete regardless of earlier failures.
 */
export async function runCleanupFunctions(): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(cleanupFunctions, fn => Promise.resolve().then(fn)),
  )
  // All cleanups have run; log any failures for diagnostics but don't throw
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )
  if (failures.length > 0) {
    // Import dynamically to avoid circular dependency with debug.ts
    const { logForDebugging } = await import('./debug.js')
    for (const failure of failures) {
      logForDebugging(
        `Cleanup function failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`,
        { level: 'error' },
      )
    }
  }
}
