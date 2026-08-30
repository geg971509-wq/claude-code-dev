import { afterEach, describe, expect, test } from 'bun:test'
import { isAnalyticsDisabled, isFeedbackSurveyDisabled } from '../config.js'

const ENV_KEYS = [
  'NODE_ENV',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
)

function clearAnalyticsEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

afterEach(() => {
  clearAnalyticsEnv()
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value !== undefined) process.env[key] = value
  }
})

describe('analytics privacy gates', () => {
  test('disables analytics without explicit telemetry opt-in', () => {
    clearAnalyticsEnv()
    expect(isAnalyticsDisabled()).toBe(true)
    expect(isFeedbackSurveyDisabled()).toBe(true)
  })

  test('allows analytics only after explicit opt-in', () => {
    clearAnalyticsEnv()
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    expect(isAnalyticsDisabled()).toBe(false)
    expect(isFeedbackSurveyDisabled()).toBe(false)
  })

  test('disable switches override explicit opt-in', () => {
    clearAnalyticsEnv()
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    process.env.DISABLE_TELEMETRY = '1'
    expect(isAnalyticsDisabled()).toBe(true)
    expect(isFeedbackSurveyDisabled()).toBe(true)

    delete process.env.DISABLE_TELEMETRY
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(isAnalyticsDisabled()).toBe(true)
    expect(isFeedbackSurveyDisabled()).toBe(true)
  })

  test('provider analytics stays disabled for third-party providers', () => {
    clearAnalyticsEnv()
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isAnalyticsDisabled()).toBe(true)
    // The survey is local UI state and remains available when telemetry is opted in.
    expect(isFeedbackSurveyDisabled()).toBe(false)
  })
})
