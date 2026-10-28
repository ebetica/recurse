import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PI_PACKAGE_ROOT } from "../../src/build_dir";
import {
  MCP_FILE_NAME,
  McpConfigError,
  SECRET_MASK,
  isPiReference,
  readMaskedMcpConfig,
  saveMcpConfig,
} from "../../src/mcp_config";
import { mcpConfig } from "../../src/extensions/extra/mcp/status";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const text = (servers: object, extra: object = {}) =>
  JSON.stringify({ mcpServers: servers, ...extra });
const stored = () => JSON.parse(readFileSync(join(dir, MCP_FILE_NAME), "utf8"));
const refusal = async (body: string) => {
  try {
    await saveMcpConfig(dir, body);
  } catch (error) {
    expect(error).toBeInstanceOf(McpConfigError);
    return (error as Error).message;
  }
  throw new Error("save was accepted");
};

test("a missing file reads as no servers", async () => {
  expect(JSON.parse(await readMaskedMcpConfig(dir))).toEqual({
    mcpServers: {},
  });
});

test("saves at mode 0600 and reads back with every secret masked", async () => {
  const masked = await saveMcpConfig(
    dir,
    text({
      gh: {
        url: "https://mcp.example/api",
        headers: { Authorization: "Bearer s3cret" },
      },
      local: {
        command: "node",
        args: ["s.mjs"],
        env: { TOKEN: "t0k" },
        loadToolsOnDemand: true,
      },
    }),
  );
  expect(statSync(join(dir, MCP_FILE_NAME)).mode & 0o777).toBe(0o600);
  expect(stored().mcpServers.gh.headers.Authorization).toBe("Bearer s3cret");
  for (const out of [masked, await readMaskedMcpConfig(dir)]) {
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("t0k");
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.gh.headers.Authorization).toBe(SECRET_MASK);
    expect(parsed.mcpServers.local.env.TOKEN).toBe(SECRET_MASK);
    expect(parsed.mcpServers.local.args).toEqual(["s.mjs"]);
    expect(parsed.mcpServers.local.loadToolsOnDemand).toBe(true);
  }
});

test("saving the masked text back keeps the stored secrets", async () => {
  await saveMcpConfig(
    dir,
    text({ gh: { url: "https://h/", headers: { Authorization: "Bearer a" } } }),
  );
  const masked = JSON.parse(await readMaskedMcpConfig(dir));
  masked.mcpServers.gh.headers["X-Other"] = "plain";
  await saveMcpConfig(dir, JSON.stringify(masked));
  expect(stored().mcpServers.gh.headers).toEqual({
    Authorization: "Bearer a",
    "X-Other": "plain",
  });
  masked.mcpServers.renamed = masked.mcpServers.gh;
  delete masked.mcpServers.gh;
  expect(await refusal(JSON.stringify(masked))).toContain(
    'server "renamed": headers "Authorization" is hidden',
  );
  expect(stored().mcpServers.gh.headers.Authorization).toBe("Bearer a");
});

test("accepts Pi's server options and refuses only non-code-mode exposure", async () => {
  const http = { url: "https://h/" };
  const accepted = {
    slack: {
      url: "https://mcp.slack.com/mcp",
      auth: "oauth",
      oauth: {
        clientId: "1601185624273.8899143856786",
        callbackUrl: "http://localhost:3118/callback",
      },
    },
    port: { ...http, oauth: { clientId: "c", callbackPort: 3118 } },
    tuned: {
      ...http,
      oauth: {
        clientId: "c",
        clientSecret: "!pass show mcp",
        scope: "read write",
        authServerMetadataUrl: "https://as.example/.well-known/openid",
      },
    },
    registered: { ...http, oauth: { clientName: "Recurse", scope: "read" } },
    document: { ...http, oauth: { clientRegistration: "cimd" } },
    provider: { ...http, auth: { provider: "anthropic" } },
    local: { command: "x", enabled: false, description: "local" },
  };
  await saveMcpConfig(dir, text(accepted));
  expect(stored().mcpServers).toEqual(accepted);
  expect(
    (await mcpConfig(join(dir, MCP_FILE_NAME))).map((entry) => entry.name),
  ).toEqual(Object.keys(accepted));
  for (const [body, message] of [
    [text({ s: { ...http, exposure: "direct" } }), "exposure"],
    [
      text({ s: { ...http, loadToolsOnDemand: "true" } }),
      "loadToolsOnDemand must be a boolean",
    ],
    [text({ s: { ...http, toolExposure: { t: "direct" } } }), "toolExposure"],
    [text({ s: { ...http, auth: "bearer" } }), 'auth must be "oauth" or'],
    [
      text({
        s: { ...http, auth: "oauth", headers: { authorization: "Bearer t" } },
      }),
      "without an Authorization header",
    ],
    [
      text({ s: { url: "http://h/", auth: { provider: "anthropic" } } }),
      "auth requires an https URL",
    ],
    [
      text({ s: { ...http, oauth: { callbackPort: 0 } } }),
      "oauth.callbackPort must be a port number",
    ],
    [
      text({ s: { ...http, oauth: { callbackUrl: "https://h/cb" } } }),
      "oauth.callbackUrl must be an http URI on localhost",
    ],
    [
      text({
        s: {
          ...http,
          oauth: { callbackUrl: "http://localhost:1/cb", callbackPort: 2 },
        },
      }),
      "name different ports",
    ],
    [
      text({
        s: { ...http, oauth: { clientRegistration: "cimd", clientId: "c" } },
      }),
      "cannot be combined with oauth.clientId",
    ],
    [
      text({ s: { ...http, oauth: { authServerMetadataUrl: "http://as/" } } }),
      "oauth.authServerMetadataUrl must be an https URL",
    ],
    [text({ s: { ...http, type: "sse" } }), "legacy SSE transport"],
    [text({ s: http }, { autoEnableCodemode: false }), "autoEnableCodemode"],
    [text({ "bad name": http }), "invalid server name"],
    [text({ s: { url: "file:///x" } }), "http or https"],
    [text({ s: {} }), "needs either"],
    ["{not json", "not valid JSON"],
  ] as const)
    expect(await refusal(body)).toContain(message);
});

test("values Pi resolves read back as written; literals stay hidden", async () => {
  const servers = {
    local: {
      command: "node",
      env: {
        VAR: "${TOKEN}",
        BARE: "$HOME/cache",
        CMD: "!cat ~/.key",
        ESCAPED: "a$$b",
        BRACED: "p${w$rd}",
        PLAIN: "t0k",
      },
    },
    gh: {
      url: "https://h/",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}", X: "s3cret" },
    },
  };
  await saveMcpConfig(dir, text(servers));
  expect(stored().mcpServers).toEqual(servers);
  const masked = JSON.parse(await readMaskedMcpConfig(dir)).mcpServers;
  expect(masked.local.env).toEqual({
    VAR: "${TOKEN}",
    BARE: "$HOME/cache",
    CMD: "!cat ~/.key",
    ESCAPED: SECRET_MASK,
    BRACED: SECRET_MASK,
    PLAIN: SECRET_MASK,
  });
  expect(masked.gh.headers).toEqual({
    Authorization: "Bearer ${GITHUB_TOKEN}",
    X: SECRET_MASK,
  });
  await saveMcpConfig(dir, JSON.stringify({ mcpServers: masked }));
  expect(stored().mcpServers).toEqual(servers);
});

test("a kept secret does not follow a changed destination", async () => {
  await saveMcpConfig(
    dir,
    text({
      gh: { url: "https://h/", headers: { Authorization: "Bearer a" } },
      local: { command: "node", args: ["s.mjs"], env: { TOKEN: "t0k" } },
      app: { url: "https://h/", oauth: { clientId: "c", clientSecret: "s3c" } },
    }),
  );
  const masked = JSON.parse(await readMaskedMcpConfig(dir));
  expect(masked.mcpServers.app.oauth.clientSecret).toBe(SECRET_MASK);
  const moved = structuredClone(masked);
  moved.mcpServers.gh.url = "https://evil/";
  expect(await refusal(JSON.stringify(moved))).toContain("url changed");
  const rerun = structuredClone(masked);
  rerun.mcpServers.local.args = ["other.mjs"];
  expect(await refusal(JSON.stringify(rerun))).toContain(
    "command, args or cwd changed",
  );
  const otherServer = structuredClone(masked);
  otherServer.mcpServers.app.oauth.authServerMetadataUrl = "https://evil/";
  expect(await refusal(JSON.stringify(otherServer))).toContain(
    "url, client ID or authServerMetadataUrl changed",
  );
  const moved_cwd = structuredClone(masked);
  moved_cwd.mcpServers.local.cwd = "/elsewhere";
  expect(await refusal(JSON.stringify(moved_cwd))).toContain("cwd changed");
  expect(stored().mcpServers.gh.headers.Authorization).toBe("Bearer a");
});

test("an unreadable stored file can be replaced by a save without masks", async () => {
  writeFileSync(join(dir, MCP_FILE_NAME), "{broken");
  expect(
    await readMaskedMcpConfig(dir).catch((e: Error) => e.message),
  ).toContain("not valid JSON");
  await saveMcpConfig(dir, text({ s: { url: "https://h/" } }));
  expect(stored().mcpServers.s.url).toBe("https://h/");
});

test("isPiReference agrees with Pi's own resolver on every short value", async () => {
  const pi = (await import(
    join(PI_PACKAGE_ROOT, "dist/core/resolve-config-value.js")
  )) as {
    getConfigValueEnvVarNames(value: string): string[];
    isCommandConfigValue(value: string): boolean;
  };
  const alphabet = ["$", "{", "}", "!", "A", "-", "1"];
  let values = [""];
  const disagreements: string[] = [];
  for (let length = 1; length <= 6; length++) {
    values = values.flatMap((head) => alphabet.map((c) => head + c));
    for (const value of values) {
      const resolved =
        pi.isCommandConfigValue(value) ||
        pi.getConfigValueEnvVarNames(value).length > 0;
      if (isPiReference(value) !== resolved) disagreements.push(value);
    }
  }
  expect(disagreements).toEqual([]);
});
