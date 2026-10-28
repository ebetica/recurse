import { expect, test } from "bun:test";
import { artifactVariables, themeStyle } from "../../src/artifacts/theme";
import {
  contrast,
  readTheme,
  renderThemeCss,
  themePalettes,
} from "../../src/themes";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { buildRoutesApp } from "./http_routes_app";

test("all built-in chart sets are distinct and readable", () => {
  for (const palette of themePalettes) {
    const variables = artifactVariables(renderThemeCss(palette));
    const charts = Object.entries(variables)
      .filter(([name]) => name.startsWith("--chart-"))
      .map(([, value]) => value);
    expect(new Set(charts).size).toBe(6);
    for (const chart of charts)
      expect(contrast(chart, variables["--bg"]!)).toBeGreaterThanOrEqual(3);
  }
});

// Feature: #2323 served Artifact colours must follow selection without rebuilding or changing confinement.
test("served HTML and app pages follow selection, preserving security headers and downloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-theme-"));
  const app = await buildRoutesApp(root, ["owner"]);
  try {
    await mkdir(join(root, "config"), { recursive: true });
    const source = join(root, "index.html");
    await writeFile(
      source,
      '<html><head><style id="recurse-theme">:root{--bg:pink}</style></head><body>Theme preview</body></html>',
    );
    const item = await artifacts.create(app.artifacts, {
      owner: "owner",
      title: "Theme",
      source,
    });
    const base = `http://127.0.0.1:${app.running.port}/api/artifacts/${item.id}`;
    const urls = [
      `${base}/page?agent=owner`,
      `${base}/file?agent=owner&path=index.html`,
    ];
    const defaults = await Promise.all(urls.map((url) => fetch(url)));
    const downloadUrl = `${urls[1]}&download=1`;
    const original = await (await fetch(downloadUrl)).text();
    for (const theme of ["Ocean", "GitHub Light", "system"]) {
      await writeFile(
        app.temp.config.paths.THEMES_FILE,
        JSON.stringify({
          theme,
          dark: "Tokyo Night",
          light: "Tokyo Night Day",
        }),
      );
      const selection = await readTheme(app.temp.config.paths.THEMES_FILE);
      for (const [index, url] of urls.entries()) {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        for (const header of [
          "content-security-policy",
          "cache-control",
          "x-content-type-options",
        ])
          expect(response.headers.get(header)).toBe(
            defaults[index]!.headers.get(header),
          );
        expect(response.headers.get("etag")).toBeNull();
        const html = await response.text();
        expect(html).toContain(themeStyle(selection.css));
        expect(html.match(/id="recurse-theme"/g)?.length).toBe(1);
        expect(html).not.toContain("--bg:pink");
        if (theme === "system")
          expect(html).toContain("@media (prefers-color-scheme: light)");
      }
      expect(await (await fetch(downloadUrl)).text()).toBe(original);
    }
  } finally {
    await app.running.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
