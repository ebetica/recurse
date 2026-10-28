// DOM-free send-readiness policy shared by the composer and focused tests.
// A send snapshots then clears staged files, so it must never race an upload.
export interface PendingComposerAttachment {
  url: string | null;
}

export function canSnapshotMessage(
  text: string,
  attachments: readonly PendingComposerAttachment[],
): boolean {
  return (
    !attachments.some((attachment) => !attachment.url) &&
    (!!text.trim() || attachments.some((attachment) => !!attachment.url))
  );
}

// One server-valid idempotency id per job survives every send retry. Distinct
// sends mint distinct ids, preventing duplicate admission on lost acks.
export function newClientMessageId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
