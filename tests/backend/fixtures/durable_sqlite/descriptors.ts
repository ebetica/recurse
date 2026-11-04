import { readdirSync, statSync } from "node:fs";

export function openDescriptors(identity: {
  dev: number;
  ino: number;
}): number[] {
  return readdirSync("/proc/self/fd").flatMap((entry) => {
    try {
      const info = statSync(`/proc/self/fd/${entry}`);
      return info.dev === identity.dev && info.ino === identity.ino
        ? [Number(entry)]
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
}
