import { expect, test } from 'bun:test'
import { generateKeybindingsTemplate } from '../template.js'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
  KeybindingsSchema,
} from '../schema.js'
import { validateUserConfig } from '../validate.js'

test('generated template satisfies schema and runtime validation', () => {
  const config = JSON.parse(generateKeybindingsTemplate())

  expect(KeybindingsSchema().safeParse(config).success).toBe(true)
  expect(
    validateUserConfig(config.bindings).filter(
      warning => warning.severity === 'error',
    ),
  ).toEqual([])
})

test('schema includes feature-gated keybinding contexts and actions', () => {
  expect(KEYBINDING_CONTEXTS).toEqual(
    expect.arrayContaining([
      'FormField',
      'Scroll',
      'MessageActions',
      'EffortPanel',
    ]),
  )
  expect(KEYBINDING_ACTIONS).toEqual(
    expect.arrayContaining([
      'scroll:pageUp',
      'scroll:pageDown',
      'scroll:lineUp',
      'scroll:lineDown',
      'scroll:top',
      'scroll:bottom',
      'selection:copy',
      'messageActions:prev',
      'messageActions:next',
      'messageActions:prevUser',
      'messageActions:nextUser',
      'messageActions:top',
      'messageActions:bottom',
      'messageActions:escape',
      'messageActions:ctrlc',
      'messageActions:enter',
      'messageActions:c',
      'messageActions:p',
    ]),
  )
})
