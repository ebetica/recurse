// Explicit operator-only push, separate from the browser proxy. A signed,
// expiring preview binds both values to confirmation without storing secrets.
// Calls have per-call and whole-request deadlines; nothing is enqueued.
// MCP is deliberately excluded: definitions can run commands outside review.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectedBackends } from "../backends/connected";
import { SYNC_KINDS, stable, type SyncItem } from "../backends/settings_sync";
import { requireBackendOperator } from "./backends";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Router, type Exchange } from "./router";

export function registerSettingsSyncRoutes(
  router: Router,
  store: ConnectedBackends,
): void {
  const secret = randomBytes(32);
  const sign = (text: string) =>
    createHmac("sha256", new Uint8Array(secret)).update(text).digest("hex");
  const call = async (
    ex: Exchange,
    signal: AbortSignal,
    path: string,
    body?: unknown,
  ) => {
    try {
      const response = await store.settingsCall(
        ex.params.label!,
        path,
        signal,
        body,
      );
      if (response.status !== 200) {
        const detail = (response.data as { detail?: unknown } | null)?.detail;
        throw new HttpError(
          response.status,
          typeof detail === "string"
            ? detail
            : `Backend refused (${response.status})`,
        );
      }
      return response.data as any;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Backend unreachable or response unavailable");
    }
  };
  router.get("/api/backends/{label}/settings-sync", async (ex) => {
    requireBackendOperator(ex);
    const signal = AbortSignal.timeout(20_000);
    const models = await call(ex, signal, "/api/models");
    const available = new Set(models.models.map((model: any) => model.id));
    const items: SyncItem[] = [];
    for (const kind of SYNC_KINDS) {
      const path = kind.path;
      const local = router.match("GET", path)!;
      const response = await local.route.handler({
        ...ex,
        path,
        params: {},
        query: {},
      });
      const after = kind.values(await response.json());
      const remote = await call(ex, signal, path);
      let before;
      try {
        before = kind.values(remote);
      } catch {
        throw new HttpError(
          502,
          "Backend settings incomplete; update the backend before syncing",
        );
      }
      for (const [key, value] of Object.entries(after)) {
        const model = kind.model?.(key, value);
        const missing = model !== undefined && !available.has(model);
        items.push({
          item: kind.title(key),
          path,
          key,
          before: before[key] ?? null,
          after: value,
          status: missing
            ? "unusable"
            : stable(before[key]) === stable(value)
              ? "same"
              : "change",
          reason: missing
            ? `Model ${model} is not available on ${ex.params.label}`
            : "",
        });
      }
    }
    if (items.length > 64)
      throw new HttpError(422, "Too many settings to sync");
    items.push({
      item: "MCP servers",
      path: "",
      before: null,
      after: null,
      status: "not synced",
      reason: `MCP servers can run commands; copy them on ${ex.params.label} directly`,
    });
    const preview = Buffer.from(
      JSON.stringify({
        label: ex.params.label,
        expires: Date.now() + 600_000,
        items,
      }),
    ).toString("base64url");
    return jsonResponse({ items, preview, signature: sign(preview) });
  });
  router.post("/api/backends/{label}/settings-sync", async (ex) => {
    requireBackendOperator(ex);
    const body = await jsonDictBody(ex);
    if (
      typeof body.preview !== "string" ||
      body.preview.length > 128 * 1024 ||
      typeof body.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.signature) ||
      !timingSafeEqual(
        new Uint8Array(Buffer.from(sign(body.preview))),
        new Uint8Array(Buffer.from(body.signature)),
      )
    )
      throw new HttpError(400, "Invalid preview; open a new preview");
    const preview = JSON.parse(
      Buffer.from(body.preview, "base64url").toString(),
    );
    if (preview.label !== ex.params.label || preview.expires < Date.now())
      throw new HttpError(409, "Preview expired; open a new preview");
    const signal = AbortSignal.timeout(20_000);
    const results = [];
    for (const item of preview.items as SyncItem[]) {
      let status: string;
      try {
        if (["unusable", "not synced"].includes(item.status))
          status = `refused: ${item.reason}`;
        else {
          const kind = SYNC_KINDS.find((kind) => kind.path === item.path)!;
          const current = await call(ex, signal, item.path);
          if (
            stable(kind.values(current)[item.key!] ?? null) !==
            stable(item.before)
          )
            status = `refused: changed on ${ex.params.label} since preview`;
          else if (item.status === "same") status = "unchanged";
          else {
            await call(
              ex,
              signal,
              item.path,
              kind.body(item.key!, item.after, current),
            );
            status = "applied";
          }
        }
      } catch (error) {
        status = `refused: ${error instanceof HttpError ? error.message : "Backend response unavailable"}`;
      }
      results.push({ item: item.item, status });
    }
    return jsonResponse({ results });
  });
}
