import { pbkdf2Sync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BackendKeys } from "../../src/auth/backend_keys";
import { registerBackendKeyRoutes } from "../../src/web/backend_keys";
import { ServiceAuth } from "../../src/auth/service";
import { OperatorAuth } from "../../src/auth/session";
import {
  logger,
  type LogSink,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { composeApp, startServer, type RunningServer } from "../../src/server";
import { registerLoginRoutes } from "../../src/web/login";
import {
  LoginThrottle,
  publishLoopbackToken,
  requestAuth,
} from "../../src/web/request_auth";
import { jsonResponse, Router, type Exchange } from "../../src/web/router";
import spec from "./fixtures/http_auth/app.json";

export interface AuthApp {
  readonly running: RunningServer;
  readonly router: Router;
  readonly operator: OperatorAuth;
  readonly throttle: LoginThrottle;
  readonly env: Record<string, string | undefined>;
  readonly envCreds: Record<string, string>;
  readonly records: RuntimeLogRecord[];
  readonly calls: { count: number };
}

export const PASSWORD = spec.password;

export async function stubResponse(ex: Exchange, template: string) {
  const body = await ex.request.arrayBuffer();
  const owned = ex.state.service_conversation_ownership;
  return jsonResponse({
    route: template,
    auth_method: ex.state.auth_method ?? null,
    principal: ex.state.principal ?? null,
    owned: Array.isArray(owned) ? owned : null,
    body_bytes: body.byteLength,
  });
}

export async function buildAuthApp(
  dataDir: string,
  options: {
    sleep?: (seconds: number) => Promise<void>;
    now?: () => number;
    backendKeys?: boolean;
    extraRoutes?: (router: Router) => void;
    port?: number;
  } = {},
): Promise<AuthApp> {
  await mkdir(dataDir, { recursive: true });
  for (const [name, content] of Object.entries(spec.tokens))
    await writeFile(join(dataDir, name), content);
  const principals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec.principals))
    principals[key] = { ...value, token_file: join(dataDir, value.token_file) };
  await writeFile(
    join(dataDir, "principals.json"),
    JSON.stringify({ principals }),
  );
  const hash = pbkdf2Sync(
    PASSWORD,
    new Uint8Array(Buffer.from(spec.salt, "hex")),
    600_000,
    32,
    "sha256",
  ).toString("hex");
  const envCreds = { CHAT_AUTH_SALT: spec.salt, CHAT_AUTH_HASH: hash };
  const env: Record<string, string | undefined> = { ...envCreds };
  const records: RuntimeLogRecord[] = [];
  const sink: LogSink = { write: (record) => void records.push(record) };
  const operator = new OperatorAuth({
    authFile: join(dataDir, "auth.json"),
    env,
    displayName: "Recurse",
    now: options.now,
  });
  const throttle = new LoginThrottle(options.now);
  const owned = new Set(spec.owned.map(([p, c]) => `${p}\u0000${c}`));
  const router = new Router();
  const web = logger("web", sink);
  const backendKeys = options.backendKeys
    ? new BackendKeys(dataDir)
    : undefined;
  if (backendKeys)
    registerBackendKeyRoutes(router, {
      operator,
      throttle,
      logger: web,
      sleep: options.sleep,
      backendKeys,
    });
  registerLoginRoutes(router, {
    backendKeys,
    operator,
    throttle,
    logger: web,
    sleep: options.sleep,
  });
  const calls = { count: 0 };
  options.extraRoutes?.(router);
  for (const [methods, template] of spec.routes as [string[], string][])
    router.add(methods, template, async (ex) => {
      calls.count += 1;
      return stubResponse(ex, template);
    });
  const handler = composeApp({
    router,
    logger: logger("http", sink),
    summaryInterval: 0,
    auth: requestAuth({
      backendKeys,
      operator,
      service: new ServiceAuth({
        principalsFile: join(dataDir, "principals.json"),
        tokenFile: null,
      }),
      loopbackToken: await publishLoopbackToken(dataDir, spec.loopback_port),
      serviceOwns: async (principal, cid) =>
        owned.has(`${principal}\u0000${cid}`),
      logger: web,
    }),
  });
  const running = startServer({ handler, logger: web, port: options.port });
  return { running, router, operator, throttle, env, envCreds, records, calls };
}
