// Load the Durable runtime (runtime.ts) once, on first use, so importing the
// host keeps the server's --check import path light.
export type Runtime = typeof import("./runtime.ts");

let value: Promise<Runtime> | null = null;

export const runtime = (): Promise<Runtime> =>
  (value ??= import("./runtime.ts"));
