import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ServiceAuth } from "../../src/auth/service";
import { OperatorAuth } from "../../src/auth/session";
import { logger, type LogSink } from "../../src/observability/runtime_logging";
import { composeApp, startServer, type RunningServer } from "../../src/server";
import { publishLoopbackToken, requestAuth } from "../../src/web/request_auth";
import type { Router } from "../../src/web/router";

export async function serveOpen(
  router: Router,
  dataDir: string,
  sink: LogSink = { write: () => {} },
): Promise<{ running: RunningServer; loopbackToken: string }> {
  await mkdir(dataDir, { recursive: true });
  const loopbackToken = await publishLoopbackToken(dataDir, 0);
  const handler = composeApp({
    router,
    logger: logger("http", sink),
    summaryInterval: 0,
    auth: requestAuth({
      operator: new OperatorAuth({
        authFile: join(dataDir, "auth.json"),
        env: {},
        displayName: "Recurse",
      }),
      service: new ServiceAuth({
        principalsFile: join(dataDir, "principals.json"),
        tokenFile: null,
      }),
      loopbackToken,
      serviceOwns: async () => false,
      logger: logger("web", sink),
    }),
  });
  return {
    running: startServer({ handler, logger: logger("web", sink) }),
    loopbackToken,
  };
}
