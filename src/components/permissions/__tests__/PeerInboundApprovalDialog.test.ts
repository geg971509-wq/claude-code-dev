import { describe, expect, test } from 'bun:test'
import { peerHoldCauseText } from '../PeerInboundApprovalDialog.js'

describe('peerHoldCauseText', () => {
  test('explains every hold cause in user-facing language', () => {
    expect(peerHoldCauseText('bypass-default')).toContain('bypassing')
    expect(peerHoldCauseText('explicit-setting')).toContain('setting')
    expect(peerHoldCauseText('mode-mismatch')).toContain('different')
    expect(peerHoldCauseText('no-mode-asserted')).toContain('did not identify')
    expect(peerHoldCauseText('mode-unknown')).toContain('could not be verified')
  })
})
