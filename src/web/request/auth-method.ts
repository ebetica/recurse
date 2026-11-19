// Routes read the authentication method already selected by the middleware.
import type { Exchange } from "../router";

type AuthMethod =
  | "backend-key"
  | "remote-callback"
  | "service"
  | "tailscale"
  | "cookie"
  | "loopback"
  | "local";

/** The request's authentication method; routes read it only through here. */
export function authMethod(ex: Exchange): AuthMethod | undefined {
  return ex.state.auth_method as AuthMethod | undefined;
}
