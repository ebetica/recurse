// Shared stop budget leaves HTTP drain margin before launcher SIGKILL.
// Instance shutdown starts with drain; then force-close, dispose store and
// exit.

/** Seconds from the launcher's SIGINT to its SIGKILL of the server group. */
export const SERVER_STOP_GRACE_SECONDS = 8;

/** Seconds the server keeps after its HTTP drain to finish and exit. */
export const SERVER_EXIT_MARGIN_SECONDS = 2;

/** Longest the server waits for in-flight requests after a stop signal. */
export const HTTP_DRAIN_SECONDS =
  SERVER_STOP_GRACE_SECONDS - SERVER_EXIT_MARGIN_SECONDS;
