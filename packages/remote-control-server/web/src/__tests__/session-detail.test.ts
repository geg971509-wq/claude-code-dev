import { describe, expect, test } from 'bun:test'

describe('SessionDetail image input', () => {
  test('exposes the shared ChatInput image and image-only submission path', async () => {
    const source = await Bun.file(
      new URL('../pages/SessionDetail.tsx', import.meta.url),
    ).text()
    expect(source).toContain('supportsImages={true}')
    expect(source).toContain('(!text && !message.images?.length)')
    expect(source).toContain('adapter.sendMessage(text, message.images)')
    expect(source).toContain('onError={setChatError}')
    expect(source).toContain(
      "setChatError(err instanceof Error ? err.message : 'Failed to initialize session')",
    )

    const inputSource = await Bun.file(
      new URL('../../components/chat/ChatInput.tsx', import.meta.url),
    ).text()
    expect(inputSource).toContain('onError?: (message: string) => void')
    expect(inputSource).toContain('onError?.(')
  })

  test('routes ACP ChatInput processing errors to its visible error banner', async () => {
    const source = await Bun.file(
      new URL('../../components/ChatInterface.tsx', import.meta.url),
    ).text()
    expect(source).toContain('onError={setErrorMessage}')
    expect(source).toContain('{errorMessage && (')
  })
})
