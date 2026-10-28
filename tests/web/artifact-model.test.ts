import { describe, expect, test } from "bun:test";
import {
  artifactDeleteUrl,
  artifactFileUrl,
  artifactImagePreviewTarget,
  artifactListUrl,
  artifactRestoreUrl,
  artifactVersionsUrl,
  externalHttpHostname,
  htmlPreviewSrcdoc,
  isSafeRasterFilename,
  pageErrorText,
} from "../../web/artifacts/model.js";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);

describe("artifact API model", () => {
  // test-check-allow: T9 Owner/version URLs, raster/CSP/relay boundaries.
  test("all immutable URLs carry the selected agent and full version", () => {
    expect(artifactListUrl("agent?a")).toBe("/api/artifacts?agent=agent%3Fa");
    expect(artifactFileUrl("agent?a", "artifact one", "index.md", SHA)).toBe(
      `/api/artifacts/artifact%20one/file?agent=agent%3Fa&version=${SHA}&path=index.md`,
    );
    expect(
      artifactFileUrl("agent?a", "artifact one", "report.pdf", OLD, true),
    ).toBe(
      `/api/artifacts/artifact%20one/file?agent=agent%3Fa&version=${OLD}&path=report.pdf&download=1`,
    );
    expect(artifactVersionsUrl("agent?a", "artifact one")).toBe(
      "/api/artifacts/artifact%20one/versions?agent=agent%3Fa",
    );
    expect(artifactRestoreUrl("artifact one")).toBe(
      "/api/artifacts/artifact%20one/restore",
    );
    expect(artifactDeleteUrl("artifact one")).toBe(
      "/api/artifacts/artifact%20one",
    );
  });
});

describe("artifact rendering policy", () => {
  // test-check-allow: T9 Owner/version URLs, raster/CSP/relay boundaries.
  test("live HTML starts with an offline CSP that still runs inline scripts", () => {
    const srcdoc = htmlPreviewSrcdoc("<h1>Hello</h1>");
    expect(
      srcdoc.startsWith('<meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    expect(srcdoc).toContain("<h1>Hello</h1>");
  });

  // test-check-allow: T9 Owner/version URLs, raster/CSP/relay boundaries.
  test("safe raster previews use the exact selected-version download URL", () => {
    const info = {
      id: "artifact one",
      title: "Results plot",
      format: "image" as const,
      filename: "plot.png",
      version: OLD,
    };
    expect(artifactImagePreviewTarget("agent?a", info.id, info, OLD)).toEqual({
      url: `/api/artifacts/artifact%20one/file?agent=agent%3Fa&version=${OLD}&path=plot.png`,
      alt: "Results plot",
    });
    expect(
      artifactImagePreviewTarget(
        "agent?a",
        info.id,
        { ...info, format: "pdf" },
        OLD,
      ),
    ).toBeNull();
    expect(
      artifactImagePreviewTarget(
        "agent?a",
        info.id,
        { ...info, filename: "plot.svg" },
        OLD,
      ),
    ).toBeNull();
    expect(artifactImagePreviewTarget(null, info.id, info, OLD)).toBeNull();
    expect(
      artifactImagePreviewTarget("agent?a", "another artifact", info, OLD),
    ).toBeNull();
    expect(
      artifactImagePreviewTarget("agent?a", info.id, info, SHA),
    ).toBeNull();
  });

  // test-check-allow: T9 Owner/version URLs, raster/CSP/relay boundaries.
  test("only safe raster filenames preview and external hosts are explicit", () => {
    expect(isSafeRasterFilename("chart.PNG")).toBe(true);
    expect(isSafeRasterFilename("drawing.svg")).toBe(false);
    expect(isSafeRasterFilename("page.html")).toBe(false);
    expect(externalHttpHostname("https://docs.example.test/path")).toBe(
      "docs.example.test",
    );
    expect(
      externalHttpHostname("https://user:secret@docs.example.test/path"),
    ).toBeNull();
    expect(externalHttpHostname("javascript:alert(1)")).toBeNull();
    expect(externalHttpHostname("/local")).toBeNull();
  });
});

describe("app page errors", () => {
  // test-check-allow: T9 Owner/version URLs, raster/CSP/relay boundaries.
  test("only a relayed string survives, cut to a short first line", () => {
    expect(
      pageErrorText({ recurseArtifactError: " TypeError: x\n at f" }),
    ).toBe("TypeError: x");
    const long = pageErrorText({ recurseArtifactError: "e".repeat(5000) })!;
    expect(long.endsWith("…")).toBeTrue();
    for (const data of [
      null,
      "TypeError: x",
      { recurseArtifactError: { toString: () => "x" } },
      { recurseArtifactError: " \n" },
      { other: "x" },
    ])
      expect(pageErrorText(data)).toBeNull();
  });
});
