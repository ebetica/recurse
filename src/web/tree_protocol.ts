// Shared opt-in tree reply envelopes; no runtime server imports.

export interface TreeDelta<Row> {
  base: string;
  changed: Row[];
  deleted: string[];
  order?: string[];
}

export type TreeUpdate<Row> = TreeDelta<Row> | { unchanged: true };
