// Preserve trash's pinned-descriptor and same-filesystem safety in a Worker.
import { sweep } from "./trash";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ roots: string[]; limit: number }>) => {
  const { roots, limit } = event.data;
  self.postMessage(roots.map((root) => sweep(root, limit)));
};
