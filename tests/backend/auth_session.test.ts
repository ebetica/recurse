import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorAuth } from "../../src/auth/session";
import fixture from "./fixtures/auth_session/cases.json";

type Env = Record<string, string> | null;
type Row = Record<string, any> & { kind: string };
const rows = fixture.cases as unknown as Row[];

async function withAuth<T>(
  file: string | { hex: string } | null,
  env: Env,
  now: number,
  fn: (auth: OperatorAuth, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "auth-session-"));
  const authFile = join(dir, "auth.json");
  if (typeof file === "string") await writeFile(authFile, file);
  else if (file)
    await writeFile(authFile, new Uint8Array(Buffer.from(file.hex, "hex")));
  try {
    const auth = new OperatorAuth({
      authFile,
      env: { ...env },
      displayName: "Recurse",
      now: () => now,
    });
    return await fn(auth, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function outcome(fn: () => Promise<unknown>) {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: (error as Error).name };
  }
}

const HASHES: Record<string, string> = {};
for (const row of rows)
  if (row.kind === "creds" && row.name === "env only")
    HASHES.env = (row.env as Record<string, string>).CHAT_AUTH_HASH!;
  else if (row.kind === "creds" && row.name === "file only")
    HASHES.file = JSON.parse(row.file as string).hash;
const envFor = (name: string) => ({
  CHAT_AUTH_SALT: "11".repeat(16),
  CHAT_AUTH_HASH: HASHES[name]!,
});

describe("auth/session parity", () => {
  test("credential precedence, fallback and verification rows", async () => {
    const creds = rows.filter((row) => row.kind === "creds");
    const got = await Promise.all(
      creds.map((row) =>
        withAuth(
          row.file as string | { hex: string } | null,
          row.env as Env,
          0,
          async (auth) => {
            const verify: Record<string, unknown> = {};
            for (const pw of Object.keys(row.verify as object))
              verify[pw] = await outcome(() => auth.verifyPassword(pw));
            return verify;
          },
        ),
      ),
    );
    creds.forEach((row, index) => {
      const filePassword = [
        "file only",
        "file wins over env",
        "hex with spaces",
      ].includes(row.name);
      const envPassword =
        !filePassword &&
        row.env?.CHAT_AUTH_HASH === HASHES.env &&
        row.env?.CHAT_AUTH_SALT === "11".repeat(16);
      for (const password of Object.keys(row.verify)) {
        const result = got[index]![password] as {
          value?: boolean;
          error?: string;
        };
        expect(result.value === true).toBe(
          (filePassword && password === "file-secret-pw") ||
            (envPassword && password === "env-secret-pw"),
        );
      }
    });
  }, 120_000);

  test("historical signed cookies verify", async () => {
    for (const row of rows.filter((r) => r.kind === "token")) {
      const env = envFor(row.hash as string);
      await withAuth(null, env, row.now as number, async (auth) => {
        expect(await auth.checkToken(row.token as string)).toBe(true);
      });
    }
  });

  test("tampered, expired, rotated and malformed cookies", async () => {
    for (const row of rows.filter((r) => r.kind === "check")) {
      const got = await withAuth(
        null,
        envFor(row.hash as string),
        row.now as number,
        (auth) => outcome(() => auth.checkToken(row.token as string | null)),
      );
      expect("value" in got && got.value === true).toBe(
        ["valid", "expiry equals now", "leading zeros", "huge expiry"].includes(
          row.name,
        ),
      );
    }
  });

  test("login HTML and fingerprints", async () => {
    await withAuth(null, null, 0, async (auth) => {
      for (const row of rows.filter((r) => r.kind === "html")) {
        const html = auth.loginHtml(row.error as string, row.value as string);
        if (row.error.includes("<")) {
          expect(
            html.match(/<p class="err">([\s\S]*?)<\/p>/)?.[1],
          ).not.toContain(row.error);
          expect(html).toContain("&lt;script&gt;");
        }
        if (row.value.includes("<")) {
          expect(html).not.toContain(row.value);
          expect(html).toContain("a&lt;b&gt;&amp;&quot;c&#x27;");
        }
      }
    });
  });
});

describe("auth/session storage and rotation", () => {
  test("setPassword stores only salt and hash; rotation voids old cookies", async () => {
    await withAuth(null, envFor("env"), 1_790_000_000, async (auth) => {
      const old = await auth.makeToken();
      expect(await auth.checkToken(old)).toBe(true);
      await auth.setPassword("brand-new-test-pw");
      const text = await readFile(auth.authFile, "utf8");
      expect(text).not.toContain("brand-new-test-pw");
      const stored = JSON.parse(text);
      expect(Object.keys(stored)).toEqual(["salt", "hash"]);
      expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(await auth.checkToken(old)).toBe(false);
      expect(await auth.checkToken(await auth.makeToken())).toBe(true);
      expect(await auth.verifyPassword("brand-new-test-pw")).toBe(true);
      expect(await auth.verifyPassword("env-secret-pw")).toBe(false);
      const firstSalt = stored.salt;
      await auth.setPassword("second-test-pw-x");
      expect(JSON.parse(await readFile(auth.authFile, "utf8")).salt).not.toBe(
        firstSalt,
      );
      await expect(stat(`${auth.authFile}.tmp`)).rejects.toThrow();
    });
  }, 60_000);
});
