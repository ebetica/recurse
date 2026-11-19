// Active Artifact preview policy, shared by server pages and HTML file frames.
const resourcePolicy =
  "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  "connect-src 'none'; font-src data:; media-src data:; frame-src 'none'; " +
  "child-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

export const ARTIFACT_APP_FRAME_CSP = `default-src 'none'; ${resourcePolicy}`;
export const ARTIFACT_ACTIVE_CSP = `default-src 'none'; sandbox allow-scripts; ${resourcePolicy}`;
