// The Recurse whose Settings are open: this one or a connected remote. Remote
// requests go through the home proxy as the operator, and the remote's key
// policy decides what succeeds. Account and Appearance always describe this
// Recurse, so only provider sign-in, Models and MCP sections follow the choice.
import { findBackend, homeBackend, type Backend } from "../backends/backend.js";

let target: Backend = homeBackend;

/** The remote label Settings configures, or "" for this Recurse. */
export const settingsLabel = (): string => target.label;

/** The remote's own page, where steps needing its address (MCP sign-in) run. */
export const settingsDirectUrl = (): string => target.directUrl;

export function setSettingsLabel(label: string): void {
  target = findBackend(label) ?? homeBackend;
}

/** The client for the Recurse shown now. Each section binds it when built, so
 * its later requests (polls, saves) never go to a Recurse chosen afterwards. */
export function settingsClient(): Pick<Backend, "api" | "jpost"> {
  const { api, jpost } = target;
  return { api, jpost };
}
