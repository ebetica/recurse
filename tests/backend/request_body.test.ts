import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COOKIE_NAME } from "../../src/auth/session";
import { buildAuthApp, PASSWORD } from "./http_auth_app";
import { buildConversationsApp } from "./http_conversations_app";
import { exchange, normalise, requestBytes } from "./http_corpus";

// Regression: #2951 Shared body parsing preserves both HTTP boundaries' validation and decoding.
test("JSON object bodies retain route validation and non-JSON decoding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "request-body-"));
  const auth = await buildAuthApp(join(dir, "auth"));
  const conversations = await buildConversationsApp(
    join(dir, "conversations"),
    {
      authEnv: auth.envCreds,
    },
  );
  const cookie = `${COOKIE_NAME}=${await auth.operator.makeToken()}`;
  const routes = [
    { port: auth.running.port, path: "/api/password", bom: "\ufeff{}" },
    {
      port: conversations.running.port,
      path: "/api/conversations/conv-a/model",
      bom: "{}",
    },
    {
      port: conversations.running.port,
      path: "/api/conversations",
      bom: "{}",
      optional: true,
    },
  ];
  const missing = [
    { type: "missing", loc: ["body"], msg: "Field required", input: null },
  ];
  const invalid = (input: unknown) => [
    {
      type: "dict_type",
      loc: ["body"],
      msg: "Input should be a valid dictionary",
      input,
    },
  ];
  try {
    for (const route of routes) {
      const send = async (body: Uint8Array, type?: string, headers = true) => {
        const response = normalise(
          await exchange(
            route.port,
            requestBytes({
              method: "POST",
              path: route.path,
              headers: [
                ...(headers ? ([["Cookie", cookie]] as const) : []),
                ...(type ? ([["Content-Type", type]] as const) : []),
              ],
              body: { hex: Buffer.from(body).toString("hex") },
            }),
          ),
          "POST",
        );
        return {
          status: response.status,
          ...(response.body as { json: unknown }),
        };
      };
      const text = (value: string) => new TextEncoder().encode(value);
      for (const value of ["", "null"]) {
        const response = await send(text(value), "application/json");
        if (route.optional) expect(response.status).toBe(200);
        else
          expect(response).toEqual({ status: 422, json: { detail: missing } });
      }
      for (const value of [[], 7, "text", false])
        expect(
          await send(text(JSON.stringify(value)), "application/json"),
        ).toEqual({
          status: 422,
          json: { detail: invalid(value) },
        });
      for (const type of [
        undefined,
        "text/plain",
        "text/json",
        "application/json/extra",
      ])
        expect(await send(text("\ufeff{}"), type)).toEqual({
          status: 422,
          json: { detail: invalid(route.bom) },
        });
      expect(await send(new Uint8Array([0xff]), "application/json")).toEqual({
        status: 400,
        json: { detail: "There was an error parsing the body" },
      });
      expect(await send(text("{"), "application/json")).toEqual({
        status: 422,
        json: {
          detail: [
            {
              type: "json_invalid",
              loc: ["body", 0],
              msg: "JSON decode error",
              input: {},
              ctx: { error: "Expecting value" },
            },
          ],
        },
      });
      const value =
        route.path === "/api/password"
          ? { current: PASSWORD, new: "short" }
          : { model: "m1" };
      for (const type of [
        "application/json",
        "Application/Problem+JSON; charset=utf-8",
      ])
        expect(
          (await send(text("\ufeff" + JSON.stringify(value)), type)).status,
        ).toBe(route.path === "/api/password" ? 400 : 200);
      expect((await send(text("{"), "application/json", false)).status).toBe(
        401,
      );
    }
  } finally {
    await auth.running.close();
    await conversations.running.close();
    await rm(dir, { recursive: true, force: true });
  }
});
