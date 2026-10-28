import { expect, test } from "bun:test";
import {
  anthropicOAuth,
  refreshAnthropicToken,
} from "../../src/auth/anthropic_oauth.ts";

test("Anthropic OAuth errors redact response bodies", async () => {
  const secret = "response-secret-should-not-escape";
  const fetcher: typeof fetch = async () =>
    new Response(secret, { status: 401 });
  await expect(
    refreshAnthropicToken("refresh", new AbortController().signal, fetcher),
  ).rejects.toThrow(new RegExp(`^(?!.*${secret}).*api\\.anthropic\\.com`));
});

test("Anthropic OAuth invalid JSON errors redact response bodies", async () => {
  const secret = "invalid-json-response-secret";
  const fetcher: typeof fetch = async () =>
    new Response(secret, { status: 200 });
  await expect(
    refreshAnthropicToken("refresh", new AbortController().signal, fetcher),
  ).rejects.toThrow(new RegExp(`^(?!.*${secret}).*api\\.anthropic\\.com`));
});

test("Anthropic OAuth rejects incomplete token responses", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({}), { status: 200 });
  await expect(
    refreshAnthropicToken("refresh", new AbortController().signal, fetcher),
  ).rejects.toThrow("invalid token response");
});

test("Anthropic OAuth getApiKey returns the existing access credential", () => {
  expect(
    anthropicOAuth.getApiKey({
      refresh: "refresh",
      access: "access-token",
      expires: Date.now() + 60_000,
    }),
  ).toBe("access-token");
});
