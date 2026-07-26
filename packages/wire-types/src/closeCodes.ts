/**
 * Application-defined WebSocket close codes (4000-4999 private-use range).
 *
 * This is a naming table for codes already in use on the wire — it documents
 * the contract, it does not define policy. Which codes a given layer treats as
 * permanent intentionally differs per layer, so each `PERMANENT_CLOSE_CODES`
 * set stays local to its transport.
 */
export const WsCloseCode = {
  /** Session expired or not found. Server could not resolve the session id. */
  SESSION_NOT_FOUND: 4001,
  /** Auth rejected: missing, malformed, or expired credentials. */
  UNAUTHORIZED: 4003,
  /**
   * Session replaced by a newer connection for the same session id.
   *
   * NOTE: `remote-control-server/src/transport/acp-relay-handler.ts` also sends
   * 4004 for "agent not found", which is a different condition. That overlap
   * predates this table and is left as-is — changing an emitted code is a wire
   * behavior change, not a rename.
   */
  SESSION_REPLACED: 4004,
} as const

export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode]
