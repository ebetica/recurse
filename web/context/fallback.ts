// One selected-view request per key, at most one in flight per conversation.
// Legacy keys are conversation ids; Durable keys include the held row revision.
export class ContextFallbackGate {
  private requestedId: string | null = null;
  private readonly inFlight = new Set<string>();

  request(id: string, conversationId = id): boolean {
    if (this.requestedId === id || this.inFlight.has(conversationId))
      return false;
    this.requestedId = id;
    this.inFlight.add(conversationId);
    return true;
  }

  settled(conversationId: string): void {
    this.inFlight.delete(conversationId);
  }

  reset(): void {
    this.requestedId = null;
  }
}
