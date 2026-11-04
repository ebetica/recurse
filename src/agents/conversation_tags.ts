// Sidebar tags on a conversation record: `{name: {at, by, until?}}`, where
// `by` is "operator" or an agent id and times are epoch seconds. Only the
// operator sets or clears OPERATOR_TAGS. A tag whose `until` has passed is
// expired: rows drop it when served, and the next change deletes it.

export interface Tag {
  at: number;
  by: string;
  until?: number;
}
export type Tags = Record<string, Tag>;
export interface TagChange {
  /** Tag name to its `until`, or null for none. */
  set: Record<string, number | null>;
  clear: string[];
}

export const OPERATOR_TAGS: ReadonlySet<string> = new Set([
  "archived",
  "snoozed",
  "pinned",
]);
export const MAX_TAGS = 16;
const NAME = /^[a-z0-9-]{1,24}$/;

/** A refused change; its message is shown to the caller. */
export class TagRefused extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate a change at `now`; only `operator` may touch OPERATOR_TAGS. */
export function parseTagChange(
  set: unknown,
  clear: unknown,
  operator: boolean,
  now: number,
): TagChange {
  if (set !== undefined && !isRecord(set))
    throw new TagRefused("set must be an object of tag names");
  if (clear !== undefined && !Array.isArray(clear))
    throw new TagRefused("clear must be a list of tag names");
  const change: TagChange = { set: {}, clear: [] };
  const check = (name: unknown): string => {
    if (typeof name !== "string" || !NAME.test(name))
      throw new TagRefused(
        "tag names are 1-24 lowercase letters, digits or '-'",
      );
    if (!operator && OPERATOR_TAGS.has(name))
      throw new TagRefused(`only the operator can change the ${name} tag`);
    return name;
  };
  for (const [name, until] of Object.entries(set ?? {})) {
    if (until !== null && (typeof until !== "number" || !(until > now)))
      throw new TagRefused(`${name}: until must be a future time or null`);
    if (name === "snoozed" && until === null)
      throw new TagRefused("snoozed needs an until time");
    change.set[check(name)] = until;
  }
  for (const name of clear ?? []) change.clear.push(check(name));
  if (!Object.keys(change.set).length && !change.clear.length)
    throw new TagRefused("no tag change");
  return change;
}

/** The unexpired, well-formed tags of a stored value. */
export function liveTags(value: unknown, now: number): Tags {
  const tags: Tags = {};
  if (!isRecord(value)) return tags;
  for (const [name, tag] of Object.entries(value)) {
    if (!isRecord(tag) || typeof tag.at !== "number") continue;
    if (typeof tag.until === "number" && tag.until <= now) continue;
    tags[name] = { ...tag } as unknown as Tag;
  }
  return tags;
}

/** `current` after `change`; expired tags are dropped. */
export function applyTagChange(
  current: unknown,
  change: TagChange,
  by: string,
  now: number,
): Tags {
  const tags = liveTags(current, now);
  for (const name of change.clear) delete tags[name];
  for (const [name, until] of Object.entries(change.set))
    tags[name] = until === null ? { at: now, by } : { at: now, by, until };
  if (Object.keys(tags).length > MAX_TAGS)
    throw new TagRefused(`a conversation has at most ${MAX_TAGS} tags`);
  return tags;
}
