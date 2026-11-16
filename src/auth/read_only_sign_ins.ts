// External sign-ins are read only; all other Pi state stays in its private dir.
// Pi refreshes OAuth only inside modify(), which this store rejects before the
// refresh callback runs. Refuse near-expiry tokens before model requests, too.
import { ReadOnlyAuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

export const SIGN_INS_NEED_REFRESH =
  "credentials need a refresh on the live instance first";

/** Existing Pi sign-ins, without file writes, command evaluation or refresh. */
export class ReadOnlySignIns extends ReadOnlyAuthStorage {
  override async read(...args: Parameters<ReadOnlyAuthStorage["read"]>) {
    let credential;
    try {
      credential = await super.read(...args);
    } catch {
      throw new Error("Cannot read the read-only sign-ins");
    }
    if (
      credential?.type === "oauth" &&
      credential.expires <= Date.now() + 60 * 60 * 1000
    )
      throw new Error(SIGN_INS_NEED_REFRESH);
    if (credential?.type === "api_key" && credential.key?.startsWith("!"))
      throw new Error("Read-only sign-ins cannot run credential commands");
    return credential;
  }
}
