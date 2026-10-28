import { expect, test } from "bun:test";
import {
  partialPrimaryArg,
  streamingDetailText,
  streamingRowText,
} from "../../web/partial-tool-args";

// test-check-allow: T9 Credential-shaped/unlisted arguments fail closed.
test("credential-shaped text fails closed like the settled summary", () => {
  for (const secret of [
    "curl -H 'Authorization: Bearer abcdefgh12345678' https://x",
    "export FOO=password=hunter2extra",
    "run --token=abcdef",
    "key=sk-abcdefgh12345678",
    "push github_pat_abcdefgh12345678",
    "aws AKIAIOSFODNN7EXAMPLE",
    "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0",
  ]) {
    expect(partialPrimaryArg("bash", `{"command":"${secret}`)).toBeNull();
    expect(streamingRowText("bash", `{"command":"${secret}`, null)).toBeNull();
  }
  expect(
    partialPrimaryArg("bash", '{"command":"git status --token-count=3"}'),
  ).toBe("git status --token-count=3");
});

// test-check-allow: T9 Credential-shaped/unlisted arguments fail closed.
test("unlisted tools stay name-only, as when settled", () => {
  expect(partialPrimaryArg("custom", '{"prompt":"secret hello"}')).toBeNull();
  expect(
    streamingRowText("custom", '{"prompt":"secret hello"}', null),
  ).toBeNull();
  expect(
    streamingDetailText("custom", '{"prompt":"secret hello"}', null),
  ).toBeNull();
  expect(streamingRowText("publish_attachment", '{"x":"y"}', null)).toBeNull();
});
