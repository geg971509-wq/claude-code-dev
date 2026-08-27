import { afterEach, describe, expect, test } from 'bun:test'
import {
  markExtractionCompleted,
  markExtractionStarted,
  resetSessionMemoryState,
} from '../sessionMemoryUtils.js'

describe('session memory extraction state', () => {
  afterEach(() => {
    resetSessionMemoryState()
  })

  test('single-flight extraction gate rejects duplicate starts', () => {
    expect(markExtractionStarted()).toBe(true)
    expect(markExtractionStarted()).toBe(false)

    markExtractionCompleted()
    expect(markExtractionStarted()).toBe(true)
  })
})
