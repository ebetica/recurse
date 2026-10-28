// Owner-file reads hold a history claim and revalidate ownership after work.
// Ownership loss (404 gone, 409 race) wins over read faults. Unknown faults
// rethrow only after revalidation; work drains before caller abort wins.

export interface Claim {
  readonly cid: string;
}

export async function claimChecked<T>(
  claim: Claim,
  work: () => Promise<[status: number | null, result: T | null]>,
  recheck: () => boolean | Promise<boolean>,
  metadataSnapshot: (cid: string) => unknown,
  signal?: AbortSignal,
): Promise<[status: number, result: T | null]> {
  const lost = (): [number, null] => [
    metadataSnapshot(claim.cid) == null ? 404 : 409,
    null,
  ];
  let workerError: number | null;
  let result: T | null;
  try {
    [workerError, result] = await work();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (!(await recheck())) return lost();
    throw error;
  }
  if (signal?.aborted) throw signal.reason;
  if (!(await recheck())) return lost();
  if (workerError !== null) return [workerError, null];
  return [200, result];
}
