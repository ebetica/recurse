import { join } from "node:path";
import type { ArtifactContext } from "../../../../src/artifacts";

const FIXED_NOW = new Date("2001-01-01T00:00:00.000Z");

export function makeContext(root: string): ArtifactContext {
  let nextId = 0;
  return {
    artifactsDir: join(root, "artifacts"),
    trashDir: join(root, "trash"),
    ids: () => (++nextId).toString(16).padStart(12, "0") + "0".repeat(20),
    now: () => new Date(FIXED_NOW),
    // The recordings predate the document/app rule and include other shapes.
    anyKind: true,
  };
}
