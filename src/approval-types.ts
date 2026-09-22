/** One pending approval, as the renderer queues and renders it. */
export type ApprovalRequest = { requestId: string; permission: string; action: string };

export type ApprovalEvidenceState = 'pending' | 'allowed' | 'denied' | 'timeout' | 'aborted' | 'shutdown';
export type ApprovalEvidence = ApprovalRequest & {
  state: ApprovalEvidenceState;
  time: string;
  reason: 'user' | 'timeout' | 'aborted' | 'shutdown' | null;
};
