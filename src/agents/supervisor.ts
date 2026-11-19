// Supervisor collection coordination is split across supervisor/ modules.
// instance.ts composes their explicit dependencies; nodes own per-agent work.
export {
  SpawnWorkdir,
  SupervisorCreate,
  type CreateDeps,
} from "./supervisor/create";
export {
  SupervisorReap,
  type DoomedScan,
  type ReapDeps,
} from "./supervisor/reap";
