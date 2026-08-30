import { expect, test } from 'bun:test'
import { THINKING_TOKEN_COUNT_BETA_HEADER } from '../../constants/betas.js'

test('uses the official thinking token count beta header', () => {
  expect(THINKING_TOKEN_COUNT_BETA_HEADER).toBe(
    'thinking-token-count-2026-05-13',
  )
})
