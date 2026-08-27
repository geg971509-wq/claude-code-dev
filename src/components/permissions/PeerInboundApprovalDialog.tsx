import { Box, Dialog, Text } from '@anthropic/ink';
import React from 'react';
import type { CrossSessionInboundMessage, PeerHoldCause } from '../../utils/crossSessionInbox.js';
import { Select } from '../CustomSelect/index.js';

type Props = {
  message: CrossSessionInboundMessage;
  cause: PeerHoldCause;
  onDecision: (decision: 'approve' | 'deny') => void;
};

export function peerHoldCauseText(cause: PeerHoldCause): string {
  switch (cause) {
    case 'bypass-default':
      return 'This session is bypassing permission prompts, so agent messages require explicit approval.';
    case 'explicit-setting':
      return 'Your cross-session message setting requires explicit approval.';
    case 'mode-mismatch':
      return 'The sender and receiver are using different permission modes.';
    case 'no-mode-asserted':
      return 'The sender did not identify its permission mode.';
    case 'mode-unknown':
      return 'The receiver permission mode could not be verified.';
  }
}

export function PeerInboundApprovalDialog({ message, cause, onDecision }: Props): React.ReactNode {
  const preview = message.content.length > 600 ? `${message.content.slice(0, 600)}...` : message.content;
  return (
    <Dialog title="Agent message waiting for approval" color="warning" onCancel={() => onDecision('deny')}>
      <Box flexDirection="column" gap={1}>
        <Text>
          From: <Text bold>{message.name ?? message.from}</Text> via {message.transport}
        </Text>
        <Text dimColor>{peerHoldCauseText(cause)}</Text>
        <Text>{preview}</Text>
      </Box>
      <Select
        defaultValue="deny"
        defaultFocusValue="deny"
        options={[
          {
            label: (
              <Text>
                Deny (<Text bold>recommended</Text>)
              </Text>
            ),
            value: 'deny',
          },
          { label: 'Approve and deliver', value: 'approve' },
        ]}
        onChange={value => onDecision(value as 'approve' | 'deny')}
        onCancel={() => onDecision('deny')}
      />
    </Dialog>
  );
}
