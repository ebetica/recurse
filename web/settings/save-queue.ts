// Settings → Models saves run in order per Recurse; reads wait for them.
const saving = new Map<string, Promise<unknown>>();

/** Runs `save` after every earlier save queued for `backend` has finished. */
export function queueSettingsSave(
  backend: string,
  save: () => Promise<void>,
): Promise<void> {
  const next = (saving.get(backend) ?? Promise.resolve()).then(save);
  saving.set(backend, next);
  return next;
}

/** Runs `read` once no save is pending for `backend`; reads again if one was
 * queued meanwhile, so the result is never older than the last save. */
export async function readAfterSettingsSaves<T>(
  backend: string,
  read: () => Promise<T>,
): Promise<T> {
  for (;;) {
    const before = saving.get(backend);
    await before;
    const value = await read();
    if (saving.get(backend) === before) return value;
  }
}
