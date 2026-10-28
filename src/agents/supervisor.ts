// Supervisor collection coordination is split across supervisor/ modules.
// instance.ts composes their explicit dependencies; nodes own per-agent work.
export * from "./supervisor/delivery";
export * from "./supervisor/reads";
export * from "./supervisor/create";
export * from "./supervisor/reap";
export * from "./supervisor/lifecycle";
