// Persist in-flight crop bytes so retry does not depend on a changed source.
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("recurse-comment-crops", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("crops");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
void database.catch(() => {});
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("crops", mode);
    const request = run(tx.objectStore("crops"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
/** Save a crop before attempting its upload. */
export async function saveCrop(id: string, blob: Blob): Promise<void> {
  await transaction("readwrite", (store) => store.put(blob, id));
}
/** Read the original crop saved for a pending send. */
export async function readCrop(id: string): Promise<Blob | null> {
  const value: unknown = await transaction("readonly", (store) =>
    store.get(id),
  );
  return value instanceof Blob ? value : null;
}
/** Remove a crop when its send or discard is complete. */
export async function removeCrop(id: string): Promise<void> {
  if (!(await database.catch(() => null))) return;
  await transaction("readwrite", (store) => store.delete(id));
}
