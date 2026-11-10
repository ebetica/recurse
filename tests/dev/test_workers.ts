/**
 * Prints test:backend's half-core worker count (min 1).
 * Refresh timings with a full passing `bun run test:backend --update-timings`.
 */
import { availableParallelism } from "node:os";

console.log(Math.max(1, Math.floor(availableParallelism() / 2)));
