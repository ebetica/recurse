// Async finders retain their last completed rows while requests are pending.
// Responses advance the displayed sequence; closing fences every prior read.
export class LazyResults {
  private requested = 0;
  private shown = 0;

  next(): number {
    return ++this.requested;
  }

  accept(sequence: number): boolean {
    if (sequence <= this.shown) return false;
    this.shown = sequence;
    return true;
  }

  clear(): void {
    this.shown = ++this.requested;
  }
}
