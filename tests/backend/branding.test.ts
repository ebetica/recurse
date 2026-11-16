import { expect, test } from "bun:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { buildApp, WebLogSink } from "../../src/web/app";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { appWorld, PASSWORD } from "./web_app_support";
import { fauxHost } from "./fixtures/durable_host/host";

// Feature: #2893 operator branding updates the manifest and native settings tool
test("name and icon persist through HTTP and native settings actions without restarting", async () => {
  const { root, env } = appWorld({ password: true });
  const fixture = fauxHost(env.CHAT_DATA_DIR!);
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const running = await app.serve({ port: 0 });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>parent.brandScriptRan=true</script><rect width="24" height="24" fill="red"/></svg>';
  const path = join(fixture.work, "icon.svg");
  await writeFile(path, svg);
  const pngPath = join(fixture.work, "icon.png");
  const png = new Uint8Array(1024 * 1024);
  png.set(
    await readFile(new URL("./fixtures/branding/icon.png", import.meta.url)),
  );
  await writeFile(pngPath, png);
  const login = await fetch(`${running.url}/login`, {
    method: "POST",
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const request = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${running.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin: running.url,
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const signedOut = await (await fetch(`${running.url}/`)).text();
    const loginIcon = signedOut.match(/<link rel="icon" href="([^"]+)"/)?.[1];
    expect(loginIcon).toBeDefined();
    const shell = await (await request("/")).text();
    const links = [
      ...shell.matchAll(
        /<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g,
      ),
    ].map((match) => match[1]!);
    expect(links).toHaveLength(4);
    const initialManifestResponse = await fetch(
      `${running.url}/manifest.webmanifest`,
    );
    expect(initialManifestResponse.status).toBe(200);
    expect(
      (await fetch(`${running.url}/manifest.webmanifest`, { method: "HEAD" }))
        .status,
    ).toBe(200);
    const initialManifest = (await initialManifestResponse.json()) as {
      icons: { src: string; type: string }[];
    };
    for (const url of [
      loginIcon!,
      ...links,
      ...initialManifest.icons.map((icon) => icon.src),
    ]) {
      const response = await fetch(`${running.url}${url}`);
      expect(response.status).toBe(200);
      expect(
        (await fetch(`${running.url}${url}`, { method: "HEAD" })).status,
      ).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("image/");
      const hash = createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex")
        .slice(0, 12);
      expect(new URL(url, running.url).searchParams.get("v")).toBe(hash);
    }
    expect((await fetch(`${running.url}/static/app.js`)).status).toBe(401);
    expect(
      (
        await fetch(`${running.url}/api/settings/branding`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"name":"No"}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/api/settings/branding",
          { name: "No" },
          { "x-recurse-agent": "c1" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/settings/branding", {
          name: "My __APP__ __VERSION__ __THEME__ __ERROR__ __VALUE__ <app> $&",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${running.url}/api/settings/branding/icon`, {
          method: "POST",
          headers: { cookie, origin: running.url },
          body: png,
        })
      ).status,
    ).toBe(200);
    const pngManifest = (await (
      await request("/manifest.webmanifest")
    ).json()) as { icons: { type: string }[] };
    expect(pngManifest.icons[0]!.type).toBe("image/png");
    expect(
      (
        await fetch(`${running.url}/api/settings/branding/icon`, {
          method: "POST",
          headers: { cookie, origin: running.url },
          body: svg,
        })
      ).status,
    ).toBe(200);
    const manifest = (await (
      await request("/manifest.webmanifest")
    ).json()) as {
      name: string;
      short_name: string;
      icons: { src: string; type: string }[];
    };
    expect(manifest.name).toBe(
      "My __APP__ __VERSION__ __THEME__ __ERROR__ __VALUE__ <app> $&",
    );
    expect(manifest.short_name).toBe(manifest.name);
    expect(manifest.icons).toHaveLength(1);
    expect(manifest.icons[0].type).toBe("image/svg+xml");
    expect((await fetch(`${running.url}${manifest.icons[0].src}`)).status).toBe(
      200,
    );
    expect(
      (
        await fetch(`${running.url}${manifest.icons[0].src}`, {
          method: "HEAD",
        })
      ).status,
    ).toBe(200);
    const icon = await request(manifest.icons[0].src);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
    expect(icon.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(await icon.text()).toBe(svg);
    const loginPage = await (await fetch(`${running.url}/`)).text();
    expect(loginPage).toContain(
      "My __APP__ __VERSION__ __THEME__ __ERROR__ __VALUE__ &lt;app&gt; $&amp;",
    );
    expect(
      (await request("/api/settings/branding/icon", "not an image")).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${running.url}/api/settings/branding/icon`, {
          method: "POST",
          headers: { cookie, origin: running.url },
          body: new Uint8Array(1024 * 1024 + 1),
        })
      ).status,
    ).toBe(400);
    fixture.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "codemode",
            {
              code: [
                'text(await searchTools("app name icon"));',
                'text(await describeTool("recurse_settings"));',
                'text(await tools.recurse_settings({action:"reset_name"}));',
                'text(await tools.recurse_settings({action:"reset_icon"}));',
                'text(await tools.recurse_settings({action:"set_name",name:"Tool name"}));',
                `text(await tools.recurse_settings({action:"set_icon",path:${JSON.stringify(pngPath)}}));`,
                `text(await tools.recurse_settings({action:"set_icon",path:${JSON.stringify(path)}}));`,
              ].join("\n"),
            },
            { id: "branding" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      (request) => {
        const results = request.messages.filter(
          (message) => message.role === "toolResult",
        ) as { isError?: boolean; content: { text: string }[] }[];
        expect(results).toHaveLength(1);
        expect(results[0]!.isError).not.toBe(true);
        const output = results[0]!.content.map((part) => part.text).join("\n");
        expect(output).toContain('"name": "Recurse"');
        expect(output).toContain('"icon": null');
        expect(output).toContain('"icon_type": "image/png"');
        return fauxAssistantMessage("done");
      },
    ]);
    const opened = await fixture.host.open("c1");
    await setSafetyReviewOff(opened.conversation, true, context);
    await fixture.host.send(
      "c1",
      "Set the app name and icon as requested.",
      "brand-settings",
    );
    await opened.conversation.waitForIdle(context);
    const updated = (await (
      await request("/manifest.webmanifest")
    ).json()) as typeof manifest;
    expect(updated.name).toBe("Tool name");
    expect(updated.icons).toEqual(manifest.icons);
    await request("/api/settings/branding", { name: null, icon: null });
    const defaults = (await (
      await request("/manifest.webmanifest")
    ).json()) as typeof manifest;
    expect(defaults.name).toBe("Recurse");
    expect(defaults.icons).toEqual(initialManifest.icons);
  } finally {
    await running.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    await fixture.host.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
