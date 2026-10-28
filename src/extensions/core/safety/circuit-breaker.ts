export const DENIAL_LIMIT = 3;

// Only genuine policy denials count. Reviewer transport, authentication,
// timeout, and formatting failures block as procedural failures but never enter
// this circuit breaker.
export class DenialCircuitBreaker {
  private denials = 0;

  recordDenial(): { count: number; open: boolean } {
    this.denials += 1;
    return { count: this.denials, open: this.denials >= DENIAL_LIMIT };
  }

  get count(): number {
    return this.denials;
  }
}
