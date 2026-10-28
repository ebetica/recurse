// Provider-facing provenance for user and hidden messages. Trusted origin and
// sender metadata are kept separate from escaped message text; neither text nor
// hidden-context values may forge Recurse or platform reminder markers.
// Remote agent ids have exactly one validated backend-label suffix.
import { escapeReminderMarkers } from "../../reminder_text";
import { splitSkillInvocation } from "../../skill_context";

const DELIVERY = "[recurse-delivery:";
const DELIVERY_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SENDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:@[A-Za-z0-9._-]{1,32})?$/;
const ORIGINS = new Set([
  "operator",
  "service",
  "agent",
  "scheduled",
  "platform",
]);
const PYTHON_SPACE =
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const strip = (value: string) => value.replace(PYTHON_SPACE, "");

export function escapeMarkers(content: string): string {
  return content.replaceAll(DELIVERY, "[recurse-delivery-quoted:");
}
export function trailerLine(deliveryId: unknown): string | null {
  return typeof deliveryId === "string" && DELIVERY_ID.test(deliveryId)
    ? `${DELIVERY}${deliveryId}]`
    : null;
}
export function escapeOriginMarkers(content: string): string {
  return content.replaceAll("[recurse-origin:", "[recurse-origin-quoted:");
}
export function escapeSenderMarkers(content: string): string {
  return content
    .replaceAll("[recurse-from-name:", "[recurse-from-name-quoted:")
    .replaceAll("[recurse-from:", "[recurse-from-quoted:");
}
export function senderLines(sender: unknown, senderName: unknown): string[] {
  if (typeof sender !== "string" || !SENDER_ID.test(sender)) return [];
  const lines = [`[recurse-from: ${sender}]`];
  if (typeof senderName === "string" && strip(senderName))
    lines.push(
      `[recurse-from-name: ${Array.from(strip(senderName)).slice(0, 256).join("")}]`,
    );
  return lines;
}
function truthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === ""
  )
    return false;
  if (Array.isArray(value)) return value.length !== 0;
  if (typeof value === "object") return Object.keys(value).length !== 0;
  return true;
}
export function messageOrigin(
  message: Record<string, unknown>,
  recipient: string | null,
): string {
  const ingress = message._ingress;
  const normalized =
    ingress !== null && typeof ingress === "object" && !Array.isArray(ingress)
      ? (ingress as Record<string, unknown>).origin
      : null;
  if (
    normalized !== null &&
    normalized !== undefined &&
    typeof normalized !== "string"
  )
    throw new Error("ingress origin must be a string");
  if (typeof normalized === "string" && ORIGINS.has(normalized))
    return normalized;
  const explicit = message.origin;
  if (
    explicit !== null &&
    explicit !== undefined &&
    typeof explicit !== "string"
  )
    throw new Error("origin must be a string");
  if (typeof explicit === "string" && ORIGINS.has(explicit)) return explicit;
  if (truthy(message.from) && message.from !== recipient) return "agent";
  if (message.source === "spawn" || message.source === "report") return "agent";
  return "platform";
}
export function formatUserMessages(
  messages: readonly Record<string, unknown>[],
  recipient: string | null = null,
): string {
  const rendered: string[] = [];
  let leadingSkill: string | null = null;
  for (const message of messages) {
    if (typeof message.content !== "string")
      throw new Error("message content must be a string");
    let content = escapeReminderMarkers(
      escapeMarkers(escapeSenderMarkers(escapeOriginMarkers(message.content))),
    );
    const trailer = trailerLine(message._delivery_id);
    if (trailer !== null) content += `\n${trailer}`;
    const skill: [string, string] | null =
      leadingSkill === null ? splitSkillInvocation(content) : null;
    if (skill !== null) [leadingSkill, content] = skill;
    rendered.push(
      [
        `[recurse-origin: ${messageOrigin(message, recipient)}]`,
        ...senderLines(message.from, message.from_name),
      ].join("\n") + `\n${content}`,
    );
  }
  const body = rendered.join("\n\n");
  return leadingSkill !== null ? `${leadingSkill} ${body}` : body;
}
export function stampMessage(
  message: Record<string, unknown>,
  recipient: string | null,
): string {
  return formatUserMessages([message], recipient);
}
export function formatHiddenMessages(
  userMessage: string,
  ...hiddenMessages: (string | null | undefined)[]
): string {
  const hidden = hiddenMessages
    .filter((item): item is string => !!item)
    .map((item) =>
      escapeMarkers(escapeSenderMarkers(escapeOriginMarkers(item))),
    )
    .join("\n\n");
  const prefix = hidden ? `${hidden}\n\n## Message\n` : "## Message\n";
  const escaped = escapeReminderMarkers(userMessage);
  const skill = splitSkillInvocation(escaped);
  return skill === null ? prefix + escaped : `${skill[0]} ${prefix}${skill[1]}`;
}
