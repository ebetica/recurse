// The Artifact viewer, injected app API and server share one UTF-8 byte cap.
export const APP_STATE_MAX_BYTES = 256 * 1024;
export const APP_STATE_FRAGMENT = "#recurse-app-state=";
export const APP_STATE_TOO_LARGE = "Saved app state exceeds 256 KiB";
export const APP_STATE_INVALID = "Saved app state must be JSON";
export const APP_STATE_RECONNECT =
  "Refresh the Artifact to reconnect saved app state";
