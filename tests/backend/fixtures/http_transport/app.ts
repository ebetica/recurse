// The scripted app behind the http_transport corpus, mirroring the FastAPI
// app in record.py route for route. `bun tests/backend/fixtures/http_transport/app.ts`
// serves it on an ephemeral port and prints the URL, for
// `python tests/backend/fixtures/http_transport/record.py --against URL`.

import {
  logger,
  type LogSink,
} from "../../../../src/observability/runtime_logging";
import { composeApp, startServer } from "../../../../src/server";
import {
  conditionalBytes,
  conditionalJson,
  PRIVATE_REVALIDATE,
} from "../../../../src/web/caching";
import { HttpError, jsonResponse, Router } from "../../../../src/web/router";
import { materialise, type BodySpec } from "../../http_corpus";
import appSpec from "./app.json";

interface ScriptedResponse {
  readonly status?: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: BodySpec;
  readonly chunks?: readonly BodySpec[];
}
const RESPONSES = appSpec.responses as unknown as Record<
  string,
  ScriptedResponse
>;

function scripted(spec: ScriptedResponse): Response {
  const headers = new Headers();
  for (const [name, value] of spec.headers) headers.append(name, value);
  const status = spec.status ?? 200;
  if (spec.chunks) {
    const parts = spec.chunks.map(materialise);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(0);
        if (index < parts.length) controller.enqueue(parts[index++]!);
        else controller.close();
      },
    });
    return new Response(body, { status, headers });
  }
  const body = materialise(spec.body);
  if (!(status < 200 || status === 204 || status === 304))
    headers.set("content-length", String(body.length));
  return new Response(status === 204 || status === 304 ? null : body, {
    status,
    headers,
  });
}

export function buildRouter(): Router {
  const router = new Router();
  router.add(["GET", "HEAD"], "/r/{name}", async (ex) =>
    scripted(RESPONSES[ex.params.name!]!),
  );
  const echo = async (ex: { request: Request }) => {
    const body = new Uint8Array(await ex.request.arrayBuffer());
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    return jsonResponse({ bytes: body.length, sha256 });
  };
  router.post("/echo", echo);
  router.post("/limited/echo", echo);
  router.get("/items/{cid}", async (ex) =>
    jsonResponse({ cid: ex.params.cid }),
  );
  router.get("/files/{rest:path}", async (ex) =>
    jsonResponse({ rest: ex.params.rest }),
  );
  router.get("/multi", async () => jsonResponse({ method: "GET" }));
  router.post("/multi", async () => jsonResponse({ method: "POST" }));
  router.get("/typed", async (ex) => jsonResponse(ex.query), {
    query: {
      agent: { type: "str", required: true },
      limit: { type: "int", default: 50 },
      offset: { type: "int" },
      since: { type: "float" },
      download: { type: "bool", default: false },
    },
  });
  router.get("/raise/{status}", async (ex) => {
    throw new HttpError(Number(ex.params.status), "scripted", {
      "X-Scripted": "1",
    });
  });
  router.get("/crash", async () => {
    throw new Error("scripted crash");
  });
  router.get("/peer", async (ex) =>
    jsonResponse({ host: ex.client?.host, scheme: ex.scheme }),
  );
  router.get("/cached", async (ex) => conditionalJson(ex.request, { n: 1 }));
  router.get("/cached-html", async (ex) =>
    conditionalBytes(
      ex.request,
      "<p>shell</p>".repeat(200),
      "text/html",
      PRIVATE_REVALIDATE,
    ),
  );
  return router;
}

/** The full middleware chain around the scripted routes. */
export function scriptedApp(sink: LogSink) {
  const log = logger("http", sink);
  return {
    log,
    handler: composeApp({
      router: buildRouter(),
      logger: log,
      summaryInterval: 0,
      // The auth slot's only transport duty here: a route body bound.
      auth: (next) => async (ex) => {
        if (ex.path.startsWith("/limited/")) ex.bodyLimit = 1000;
        return next(ex);
      },
    }),
  };
}

if (import.meta.main) {
  const { log, handler } = scriptedApp({ write: () => {} });
  const running = startServer({ logger: log, handler, installSignals: true });
  console.log(running.url);
}
