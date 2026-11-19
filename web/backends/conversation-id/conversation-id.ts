// Qualified conversation ids without backend discovery or request health.
// Home ids stay unqualified; remote ids carry a backend label and local id.
import { validBackendLabel } from "../../../src/backends/label/index.js";

export function parseConversationId(id: string): {
  label: string;
  cid: string;
} {
  const slash = id.indexOf("/");
  if (slash === -1) return { label: "", cid: id };
  const label = id.slice(0, slash);
  const cid = id.slice(slash + 1);
  if (!validBackendLabel(label) || !cid || cid.includes("/"))
    throw new Error("Invalid backend conversation id");
  return { label, cid };
}

export function conversationId(label: string, cid: string): string {
  if (cid.includes("/") || (label && !validBackendLabel(label)))
    throw new Error("Invalid backend conversation id");
  return label ? `${label}/${cid}` : cid;
}
