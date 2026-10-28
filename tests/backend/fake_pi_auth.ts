import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORAGE = `
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
export class FileAuthStorageBackend {
  constructor(path) { this.path = path; }
  withLock(fn) {
    if (read(this.path) === undefined) write(this.path, "{}");
    const lock = this.path + ".fake-lock";
    for (;;) { try { mkdirSync(lock); break; } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }}
    try { const change = fn(read(this.path));
      if (typeof change.next === "string") write(this.path, change.next);
      return change.result;
    } finally { rmdirSync(lock); }
  }
}
function read(path) { try { return readFileSync(path, "utf8"); }
  catch (e) { if (e?.code === "ENOENT") return undefined; throw e; } }
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
`;

const PI = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const VERSION = "1.3.0";
const backendUrl = new URL("./dist/core/auth-storage.js", import.meta.url).href;
const { FileAuthStorageBackend } = await import(backendUrl);
function read(path) { try { return readFileSync(path, "utf8"); }
  catch (e) { if (e?.code === "ENOENT") return undefined; throw e; } }
export function readStoredCredential(providerId, authPath) {
  try { return JSON.parse(read(authPath) ?? "{}")[providerId]; } catch { return undefined; }
}
export class ModelRuntime {
  constructor(authPath, modelsPath) { this.authPath = authPath; this.modelsPath = modelsPath; }
  static async create(options = {}) { return new ModelRuntime(options.authPath, options.modelsPath); }
  registerProvider() {}
  async refresh() {}
  async getAuth(providerId) {
    const credential = readStoredCredential(providerId, this.authPath);
    if (!credential) return undefined;
    if (credential.type === "api_key") return credential.key ? { auth: { apiKey: credential.key } } : undefined;
    if (credential.type !== "oauth") return undefined;
    if (Date.now() + 5 * 60 * 1000 >= credential.expires) {
      if (credential.refresh !== "ok") throw new Error("OAuth refresh failed");
      const next = { type: "oauth", access: "refreshed", refresh: "ok", expires: Date.now() + 3600 * 1000 };
      new FileAuthStorageBackend(this.authPath).withLock((current) => {
        const data = JSON.parse(current ?? "{}"); data[providerId] = next;
        return { result: null, next: JSON.stringify(data, null, 2) + "\\n" };
      });
      return { auth: { headers: { Authorization: "Bearer " + next.access } } };
    }
    return { auth: { headers: { Authorization: "Bearer " + credential.access } } };
  }
}
export class ModelRegistry {
  constructor(runtime) { this.runtime = runtime; }
  custom(provider, id) {
    const path = this.runtime?.modelsPath; if (!path) return undefined;
    let config; try { config = JSON.parse(read(path) ?? "{}"); } catch { return undefined; }
    const models = config?.providers?.[provider]?.models;
    return Array.isArray(models) ? models.find((model) => model?.id === id) : undefined;
  }
  find(provider, id) {
    const custom = this.custom(provider, id);
    if (custom) return { id, name: custom.name || id, contextWindow: custom.contextWindow };
    if (provider !== "openrouter" || !["vendor/known", "vendor/second"].includes(id)) return undefined;
    return { id, name: "OpenRouter " + id, contextWindow: id === "vendor/known" ? 123456 : 654321 };
  }
}
`;

export function fakePiPackage(root: string): string {
  const packageRoot = join(root, "@earendil-works", "pi-coding-agent");
  mkdirSync(join(packageRoot, "dist", "core"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.3.0",
      type: "module",
      exports: { ".": { import: "./index.mjs" } },
    }),
  );
  writeFileSync(join(packageRoot, "index.mjs"), PI);
  writeFileSync(join(packageRoot, "dist", "core", "auth-storage.js"), STORAGE);
  return packageRoot;
}
