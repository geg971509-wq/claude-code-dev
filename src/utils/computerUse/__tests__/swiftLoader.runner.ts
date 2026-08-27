import { describe, expect, mock, test } from 'bun:test'

const requests: string[] = []
mock.module('@ant/computer-use-swift', () => ({
  computerUse: {
    tcc: {
      requestAccessibility: () => requests.push('accessibility'),
      requestScreenRecording: () => requests.push('screenRecording'),
    },
  },
}))

const swiftLoader = (await import('../swiftLoader.js')) as Record<
  string,
  (...args: unknown[]) => unknown
>

describe('requestComputerUseTccPermission', () => {
  test('routes both permission requests to the native TCC bridge', () => {
    swiftLoader.requestComputerUseTccPermission('accessibility')
    swiftLoader.requestComputerUseTccPermission('screenRecording')
    expect(requests).toEqual(['accessibility', 'screenRecording'])
  })
})
