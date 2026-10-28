// The status line beside Settings > Effort ladder > Update model list.
// Pure: the Settings section fetches /api/settings/model-list-update and
// renders this text.

export interface ModelListUpdateStatus {
  updating: boolean;
  /** Epoch seconds of the last successful update from pi.dev. */
  updated_at: number | null;
  /** Models in Pi's stored list; null before the server first lists them. */
  count: number | null;
  /** Why the last update failed, else null. */
  error: string | null;
}

export function modelListStatusText(
  status: ModelListUpdateStatus,
  formatTime: (epochSeconds: number) => string = (seconds) =>
    new Date(seconds * 1000).toLocaleString(),
): string {
  if (status.updating) return "Updating the model list from pi.dev…";
  const since =
    status.updated_at === null
      ? "Pi's current list"
      : `the list from ${formatTime(status.updated_at)}`;
  if (status.error) {
    const reason = /[.!?]$/u.test(status.error)
      ? status.error
      : `${status.error}.`;
    return `Could not update: ${reason} Using ${since}.`;
  }
  if (status.count === null) return "Pi's model list has not been read yet.";
  const models = `${status.count} model${status.count === 1 ? "" : "s"}`;
  return status.updated_at === null
    ? `${models} in Pi's list.`
    : `${models}, updated ${formatTime(status.updated_at)}.`;
}
