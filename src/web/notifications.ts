// Operator routes for agent-finished notification devices, under
// /api/settings/ so request_auth refuses agent-marked requests; only the
// VAPID public key is returned. Also serves the root-scope worker
// (web/push-worker.ts) and the manifest iOS needs for Home Screen Web Push.

import { readFile } from "node:fs/promises";
import { brandResponse, readBrand } from "../branding";

import {
  parseSubscription,
  PushSubscriptionError,
  type PushNotifications,
} from "../push_notifications";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Router } from "./router";

export function registerNotificationRoutes(
  router: Router,
  push: Pick<PushNotifications, "publicKey" | "subscribe" | "unsubscribe">,
  page: { workerSource: string; displayName: string; brandingFile?: string },
): void {
  let worker: Promise<string> | null = null;
  router.get("/push-worker.js", async () => {
    worker ??= readFile(page.workerSource, "utf8").then((source) =>
      new Bun.Transpiler({ loader: "ts" }).transformSync(source),
    );
    worker.catch(() => (worker = null));
    return new Response(await worker, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  });
  router.get("/manifest.webmanifest", async () => {
    const brand = brandResponse(
      page.brandingFile
        ? await readBrand(page.brandingFile)
        : { name: null, icon: null },
      page.displayName,
    );
    return jsonResponse({
      name: brand.name,
      short_name: brand.name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: brand.icon
        ? [
            {
              src: brand.icon,
              sizes: "any",
              type: brand.icon_type,
              purpose: "any maskable",
            },
          ]
        : [
            {
              src: "/static/brand/app-icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
            ...[192, 512].flatMap((size) =>
              ["any", "maskable"].map((purpose) => ({
                src: `/static/brand/app-icon${purpose === "maskable" ? "-maskable" : ""}-${size}.png`,
                sizes: `${size}x${size}`,
                type: "image/png",
                purpose,
              })),
            ),
          ],
    });
  });
  const refused = (error: unknown): never => {
    if (error instanceof PushSubscriptionError)
      throw new HttpError(422, error.message);
    throw new HttpError(503, "notification settings are unavailable");
  };
  router.get("/api/settings/notifications", async () =>
    jsonResponse({ public_key: await push.publicKey().catch(refused) }),
  );
  router.post("/api/settings/notifications/devices", async (ex) => {
    const body = await jsonDictBody(ex);
    let origin = "";
    try {
      origin = new URL(ex.request.headers.get("origin") ?? "").origin;
    } catch {}
    try {
      await push.subscribe(parseSubscription(body.subscription, origin));
    } catch (error) {
      refused(error);
    }
    return jsonResponse({ subscribed: true });
  });
  router.post("/api/settings/notifications/devices/remove", async (ex) => {
    const endpoint = (await jsonDictBody(ex)).endpoint;
    if (typeof endpoint !== "string")
      throw new HttpError(422, "endpoint required");
    await push.unsubscribe(endpoint).catch(refused);
    return jsonResponse({ subscribed: false });
  });
}
