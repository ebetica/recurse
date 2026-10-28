// Upload annotation for Durable turns. Resolve admitted files, then check that
// their collection and agent lifetime are still current before exposing paths.
import type { Config } from "../../config";
import type { ConversationStore } from "../conversation_store";
import { uploadPromptParts } from "./attachments/published";
import { collectionSnapshot, type CollectionSnapshot } from "./node_files";
import { formatHiddenMessages } from "./prompt_stamp";

type Image = import("@earendil-works/pi-ai").ImageContent &
  Record<string, unknown>;

/** Python bool() over a JSON value. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object")
    return Object.keys(value).length > 0;
  return Boolean(value);
}

export interface TurnPrepDeps {
  conversations: Pick<ConversationStore, "metadataSnapshot">;
  existingNode(cid: string): { readonly reaping: boolean } | null;
  config: Pick<Config, "agentTempLeaf" | "paths">;
}

const sameSnapshot = (
  a: CollectionSnapshot | null,
  b: CollectionSnapshot | null,
): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.collection === b.collection &&
    a.owner === b.owner &&
    a.temp_key === b.temp_key);

export class TurnPrep {
  constructor(private readonly deps: TurnPrepDeps) {}

  /** Project upload paths and raster content, writing nothing. */
  async uploadParts(
    text: string,
    cid: string | null,
    snapshot: CollectionSnapshot | null,
    attachmentIds: readonly string[] = [],
  ): Promise<[string, readonly Image[]]> {
    const node = cid !== null ? this.deps.existingNode(cid) : null;
    const [paths, images] =
      snapshot === null
        ? [[], []]
        : await uploadPromptParts(
            text,
            snapshot.collection,
            snapshot.owner,
            attachmentIds,
          );
    if (
      !paths.length ||
      (cid !== null && !this.annotationFresh(cid, snapshot, node))
    )
      return [text, []];
    const block =
      "[Attached file(s) are on disk — open them with your Read tool if needed:\n" +
      paths.map((p) => `- ${p}`).join("\n") +
      "]";
    return [formatHiddenMessages(text, block), images];
  }

  /** Await-free: the captured annotation lifetime is still current. */
  private annotationFresh(
    cid: string,
    snapshot: CollectionSnapshot | null,
    node: { readonly reaping: boolean } | null,
  ): boolean {
    if (snapshot === null || snapshot.owner !== cid) return false;
    const conv = this.deps.conversations.metadataSnapshot(cid);
    const fresh =
      conv === null ? null : collectionSnapshot(conv, this.deps.config);
    if (!sameSnapshot(fresh, snapshot)) return false;
    if (this.deps.existingNode(cid) !== node) return false;
    return node === null || !node.reaping;
  }
}
