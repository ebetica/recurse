// Permanent-deletion fence for one agent node.
//
// One job: carry the reap fence one node owns and answer the shared admission
// question.

/** Whether permanent reap owns this node and whether it still admits work. */
export class Fence {
  /** Set once by reap and never cleared while this node remains attached. */
  fenced = false;

  /** Install the fence for permanent deletion; true only on the first call. */
  beginReap(): boolean {
    if (this.fenced) return false;
    this.fenced = true;
    return true;
  }

  /** Admission requires an unfenced current binding with no reap owner. */
  admits(current: boolean, retiring: boolean): boolean {
    return !this.fenced && current && !retiring;
  }
}
