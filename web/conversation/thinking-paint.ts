// Per-paint marker read by the live bar after the thread marks shown thinking.
let committedStep: string | null = null;

export function resetCommittedStep(): void {
  committedStep = null;
}

export function markCommittedStep(key: string): void {
  committedStep = key;
}

export function showsCommittedStep(key: string | null): boolean {
  return committedStep === key;
}
