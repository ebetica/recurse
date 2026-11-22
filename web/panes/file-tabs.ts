// File tabs use the existing pane lifecycle and native conversation layout.
// Only registered sources decode descriptors; metadata never supplies URLs.
// A tab keeps its id when stepping; its descriptor identifies the shown file.
// Definitions, open tabs and retained pane bodies have separate live bounds.
import { validBoundedString } from "../conversation-ui-state/schema.js";
import type { PaneDef } from "../types.js";

export interface FileTabDescriptor {
  source: string;
  key: string;
}
interface FileTabPane extends PaneDef {
  guardClose(element: HTMLElement, preserveComments: boolean): boolean;
  prepare?(value: unknown): void;
  release?(): void;
}
type Factory = (key: string, id: string) => FileTabPane | null;
const sources = new Map<string, Factory>();
export const MAX_OPEN_FILE_TABS = 8;
const MAX_DEFINITIONS = 32;
const MAX_KEY_LENGTH = 8192;

/** Decode a canonical key before the source checks the identities in it. */
export function decodeFileTabKey(
  key: string,
  parts: number,
  maxLength = MAX_KEY_LENGTH,
): string[] | null {
  let values: unknown;
  try {
    values = JSON.parse(key);
  } catch {
    return null;
  }
  if (
    !Array.isArray(values) ||
    values.length !== parts ||
    values.some(
      (value) =>
        !validBoundedString(value, maxLength) || /[\x00-\x1f]/.test(value),
    ) ||
    JSON.stringify(values) !== key
  )
    return null;
  return values;
}

export function registerFileTabSource(source: string, factory: Factory): void {
  if (!sources.has(source)) sources.set(source, factory);
}

/** Accept only registered file metadata, never arbitrary panel parameters. */
export function fileTabDescriptor(
  id: string,
  parameters: unknown,
): FileTabDescriptor | null {
  if (
    !/^file:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    Object.keys(parameters).join() !== "file"
  )
    return null;
  const file = (parameters as { file: unknown }).file;
  if (!file || typeof file !== "object" || Array.isArray(file)) return null;
  const descriptor = file as Record<string, unknown>;
  if (
    Object.keys(descriptor).length !== 2 ||
    !Object.hasOwn(descriptor, "source") ||
    !Object.hasOwn(descriptor, "key") ||
    typeof descriptor.source !== "string" ||
    !sources.has(descriptor.source) ||
    !validBoundedString(descriptor.key, MAX_KEY_LENGTH)
  )
    return null;
  return { source: descriptor.source, key: descriptor.key };
}

function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `file:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class FileTabs {
  private entries = new Map<
    string,
    { descriptor: FileTabDescriptor; pane: FileTabPane }
  >();
  private wanted = new Set<string>();

  constructor(
    private readonly opened: ReadonlySet<string>,
    private readonly retained: (id: string, ownerId?: string) => boolean,
  ) {}

  definitions(): FileTabPane[] {
    return [...this.entries.values()].map((entry) => entry.pane);
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  needed(id: string): boolean {
    return this.opened.has(id) || this.wanted.has(id);
  }
  prepare(ids: readonly string[]): void {
    const next = new Set(ids.filter((id) => this.has(id)));
    for (const id of this.wanted)
      if (!next.has(id) && !this.opened.has(id))
        this.entries.get(id)?.pane.release?.();
    this.wanted = next;
  }
  closed(id: string): void {
    this.wanted.delete(id);
    this.entries.get(id)?.pane.release?.();
  }
  descriptor(id: string): FileTabDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }
  private find(
    source: string,
    key: string,
    ownerId: string,
  ): FileTabPane | undefined {
    const matches = [...this.entries.values()].filter(
      (entry) =>
        entry.descriptor.source === source && entry.descriptor.key === key,
    );
    return (
      matches.find(({ pane }) => this.opened.has(pane.id)) ||
      matches.find(({ pane }) => this.wanted.has(pane.id)) ||
      matches.find(({ pane }) => this.retained(pane.id, ownerId)) ||
      matches[0]
    )?.pane;
  }
  restore(id: string, parameters: unknown): boolean {
    const descriptor = fileTabDescriptor(id, parameters);
    if (!descriptor) return false;
    const existing = this.entries.get(id);
    if (existing && existing.descriptor.source !== descriptor.source)
      return false;
    const matching = existing?.descriptor.key === descriptor.key;
    if (existing && !matching && this.opened.has(id)) return false;
    const pane = matching
      ? existing.pane
      : sources.get(descriptor.source)!(descriptor.key, id);
    if (!pane || pane.id !== id) return false;
    if (!matching) existing?.pane.release?.();
    this.entries.delete(id);
    this.entries.set(id, { descriptor, pane });
    while (this.entries.size > MAX_DEFINITIONS) {
      const retired = [...this.entries.keys()].find(
        (key) => key !== id && !this.needed(key) && !this.retained(key),
      );
      if (!retired) {
        this.entries.delete(id);
        pane.release?.();
        return false;
      }
      this.entries.get(retired)?.pane.release?.();
      this.entries.delete(retired);
    }
    return true;
  }
  replace(
    id: string,
    key: string,
    initial: unknown,
    detach: () => void,
  ): { descriptor: FileTabDescriptor; pane: FileTabPane } | null {
    const current = this.entries.get(id);
    if (!current || !this.opened.has(id) || current.descriptor.key === key)
      return null;
    const descriptor = fileTabDescriptor(id, {
      file: { source: current.descriptor.source, key },
    });
    const pane = descriptor && sources.get(descriptor.source)!(key, id);
    if (!descriptor || !pane || pane.id !== id) return null;
    pane.prepare?.(initial);
    detach();
    current.pane.release?.();
    const entry = { descriptor, pane };
    this.entries.set(id, entry);
    return entry;
  }
  canOpen(id?: string): boolean {
    return (
      (!!id && this.opened.has(id)) ||
      [...this.opened].filter((key) => this.has(key)).length <
        MAX_OPEN_FILE_TABS
    );
  }
  create(
    source: string,
    key: string,
    initial: unknown,
    ownerId: string,
  ): string | null {
    const existing = this.find(source, key, ownerId);
    if (!this.canOpen(existing?.id)) return null;
    const id = existing?.id || newFileId();
    if (!this.restore(id, { file: { source, key } })) return null;
    this.entries.get(id)!.pane.prepare?.(initial);
    return id;
  }
}
