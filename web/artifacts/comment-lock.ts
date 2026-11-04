// Without Web Locks, a separate IndexedDB transaction serializes sends across
// tabs, with pending requests keeping ownership through uploads and cleanup.
// Unlike a lease, it cannot expire while paused. Tab closure releases it;
// persisted operation keys and server idempotency recover interrupted sends.

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("recurse-comment-send-lock", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("lock");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
/** Coordinate a complete send or discard, checking ownership after awaits. */
export async function withCommentLock(
  key: string,
  work: (check: () => void) => Promise<void>,
): Promise<void> {
  if (navigator.locks)
    return navigator.locks.request(key, () => work(() => {}));
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("lock", "readwrite");
    const store = tx.objectStore("lock");
    let active = true;
    let started = false;
    let done = false;
    let failure: unknown;
    const check = () => {
      if (!active) throw new Error("Comment coordination interrupted");
    };
    tx.oncomplete = () => {
      active = false;
      if (failure) reject(failure);
      else resolve();
    };
    tx.onabort = () => {
      active = false;
      failure ??= tx.error || new Error("Comment coordination interrupted");
      if (done || !started) reject(failure);
    };
    const pulse = () => {
      const request = store.get(0);
      request.onsuccess = () => {
        if (!started) {
          started = true;
          void Promise.resolve()
            .then(() => work(check))
            .catch((error: unknown) => {
              failure = error;
            })
            .finally(() => {
              done = true;
              if (!active) reject(failure);
            });
        }
        if (!done) pulse();
      };
    };
    pulse();
  });
}
