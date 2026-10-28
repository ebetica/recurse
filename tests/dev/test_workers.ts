/**
 * Prints the bun test worker count for test:backend: half the cores, min 1.
 */
import { availableParallelism } from "node:os";

console.log(Math.max(1, Math.floor(availableParallelism() / 2)));
