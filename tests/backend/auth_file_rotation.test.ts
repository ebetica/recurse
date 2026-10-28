import { expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthApp } from "./http_auth_app";

// Regression: #2689 Atomic credential replacement must not reject valid service requests.
test("service credentials remain valid during atomic replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auth-file-rotation-"));
  const app = await buildAuthApp(dir);
  const secret = (await readFile(join(dir, "alpha-token"), "utf8")).trim();
  const request = () =>
    fetch(`http://127.0.0.1:${app.running.port}/api/service/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer recurse_alpha_${secret}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
  try {
    for (const name of ["alpha-token", "principals.json"]) {
      const path = join(dir, name);
      const bytes = await readFile(path, "utf8");
      const statuses = new Set<number>();
      const writer = async () => {
        for (let i = 0; i < 1000; i++) {
          await writeFile(path + ".tmp", bytes);
          await rename(path + ".tmp", path);
        }
      };
      const reader = async () => {
        for (let i = 0; i < 200; i++) {
          const response = await request();
          statuses.add(response.status);
          await response.arrayBuffer();
        }
      };
      await Promise.all([writer(), ...Array.from({ length: 8 }, reader)]);
      expect({ name, statuses: [...statuses] }).toEqual({
        name,
        statuses: [200],
      });
      await writeFile(path, "");
      const refused = await request();
      expect(refused.status).toBe(401);
      await refused.arrayBuffer();
      await writeFile(path, bytes);
    }
  } finally {
    await app.running.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
