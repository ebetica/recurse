import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  captureErrors,
  gotoRoot,
  runBrowserTests,
  type BrowserTest,
  openSettingsPanel,
  expectHitCorners,
} from "./common";
import { closeDetails, expectModalSheet, openDetail } from "./settings_support";
import { expect as browserExpect } from "playwright/test";

const subscriptionToken = () => ({
  access_token: `h.${Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 7200,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
    }),
  ).toString("base64url")}.s`,
  refresh_token: "sk-test-cref",
  expires_in: 7200,
});

export const tests: BrowserTest[] = [
  // Feature: #2963 subscription sign-in opens the provider and takes the pasted address.
  async function test_subscription_sign_in_pastes_the_redirect_address(
    browser,
    base,
    data,
  ) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    for (const [authorize, callback, code] of [
      [
        "https://claude.ai/oauth/authorize",
        "http://localhost:53692/callback",
        "claude-code",
      ],
      [
        "https://auth.openai.com/oauth/authorize",
        "http://localhost:1455/auth/callback",
        "chatgpt-code",
      ],
    ]) {
      await context.route(`${authorize}**`, (route) => {
        const state = new URL(route.request().url()).searchParams.get("state");
        const target = `${callback}?code=${code}&state=${state}`;
        return route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(target)})</script>`,
        });
      });
      await context.route(`${callback}**`, (route) =>
        route.fulfill({ status: 404, body: "unreachable" }),
      );
    }
    const page = await context.newPage();
    const errors = captureErrors(page);
    const requests: Record<string, string>[] = [];
    const replies: [number, string][] = [
      [
        200,
        JSON.stringify({
          access_token: "sk-test-acc",
          refresh_token: "sk-test-ref",
          expires_in: 3600,
        }),
      ],
      [429, "slow"],
    ];
    const tokens = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (call) => {
        requests.push({
          path: new URL(call.url).pathname,
          ...Object.fromEntries(new URLSearchParams(await call.text())),
        });
        const [status, body] = replies.shift() ?? [500, "no reply"];
        return new Response(body, { status });
      },
    });

    try {
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.request.post(`${base}__browser-test/subscription-token-urls`, {
        data: {
          claude: `${tokens.url}claude/token`,
          chatgpt: `${tokens.url}codex/token`,
        },
      });
      const codexHome = join(data, "home", ".codex");
      await mkdir(codexHome);
      const cliFile = Bun.file(join(codexHome, "auth.json"));
      const cliJson = JSON.stringify({ tokens: subscriptionToken() });
      await Bun.write(cliFile, cliJson);
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="providers"]').tap();
      await openDetail(page, /^OpenAI /);
      const cliSection = page.getByRole("region", {
        name: "OpenAI",
        exact: true,
      });
      await browserExpect(
        cliSection.getByText("Signed in through Codex CLI"),
      ).toBeVisible();
      const disconnect = cliSection.getByRole("button", {
        name: "Disconnect Codex",
        exact: true,
      });
      await expectHitCorners(disconnect);
      await disconnect.tap();
      const confirm = page.getByRole("dialog", {
        name: "Disconnect Codex from Recurse?",
      });
      const cancel = confirm.getByRole("button", { name: "Cancel" });
      await browserExpect(cancel).toBeFocused();
      await cancel.press("Enter");
      await browserExpect(confirm).toBeHidden();
      await browserExpect(disconnect).toBeFocused();
      await disconnect.tap();
      await cancel.press("Escape");
      await browserExpect(confirm).toBeHidden();
      await browserExpect(disconnect).toBeFocused();
      await disconnect.tap();
      await confirm.getByRole("button", { name: "Disconnect Codex" }).tap();
      await browserExpect(
        cliSection.locator(".openai-subscription .credential-status"),
      ).toHaveText("Not signed in");
      expect(await cliFile.text()).toBe(cliJson);
      const signIn = async (title: string, name: string) => {
        await closeDetails(page);
        await page
          .locator(
            `.provider[data-provider="${title.toLowerCase()}"] > .settings-detail > button.settings-row`,
          )
          .tap();
        const section = page.getByRole("region", { name: title, exact: true });
        const isClaude = title === "Claude";
        const card = (heading: string) =>
          section.locator("section").filter({
            has: page.getByRole("heading", { name: heading, exact: true }),
          });
        const keyCard = isClaude ? section : card("API key");
        const subCard = isClaude ? section : card("ChatGPT subscription");
        const edit = keyCard.getByRole("button", {
          name: isClaude ? "API key" : "Add API key",
          exact: true,
        });
        await edit.tap();
        const save = keyCard.getByRole("button", {
          name: "Save key",
          exact: true,
        });
        await browserExpect(save).toBeVisible();
        const saveKey = async () => {
          await keyCard
            .getByLabel("OpenAI API key")
            .fill("browser-test-openai-key");
          await save.tap();
          await browserExpect(
            keyCard.getByText("Saved", { exact: true }),
          ).toBeVisible();
        };
        if (!isClaude) await saveKey();
        await subCard
          .getByRole("button", {
            name: isClaude ? "Subscription" : "Sign in",
            exact: true,
          })
          .tap();
        await browserExpect(keyCard.locator(".keypanel")).toBeHidden();
        const open = subCard.getByRole("link", {
          name: `Open ${name} sign-in`,
        });
        const answer = subCard.getByRole("textbox", {
          name: `Address after signing in to ${name}`,
        });
        const finish = subCard.getByRole("button", { name: "Finish sign-in" });
        for (const control of [open, answer, finish]) {
          await expectHitCorners(control);
        }
        await browserExpect(open).toBeFocused();
        const [provider] = await Promise.all([
          context.waitForEvent("page"),
          open.tap(),
        ]);
        await provider.waitForURL(/^http:\/\/localhost:\d+\/.*\?code=/);
        const state = new URL(provider.url()).searchParams.get("state");
        await answer.fill(provider.url());
        await provider.close();
        await finish.tap();
        return { section, state, subCard, keyCard, edit, saveKey };
      };

      const claude = await signIn("Claude", "Claude");
      await browserExpect(
        claude.section.getByText("Logged in with your Claude subscription."),
      ).toBeVisible();
      await browserExpect(
        page.locator(
          '.provider[data-provider="claude"] > .settings-detail > button.settings-row .settings-row-value',
        ),
      ).toHaveText("Subscription · signed in");
      await browserExpect(claude.section.locator(".paste-sign-in")).toHaveCount(
        0,
      );

      const chatgpt = await signIn("OpenAI", "ChatGPT");
      const { subCard, keyCard } = chatgpt;
      const command = subCard.locator(".localfb pre");
      await browserExpect(command).toContainText("code=chatgpt-code");
      await browserExpect(subCard.locator(".paste-sign-in")).toHaveCount(0);
      await subCard
        .getByRole("textbox", { name: "Command output" })
        .fill(JSON.stringify(subscriptionToken()));
      await subCard
        .locator(".localfb")
        .getByRole("button", { name: "Finish sign-in" })
        .tap();
      await browserExpect(
        subCard.getByText("Logged in with your ChatGPT subscription."),
      ).toBeVisible();
      await browserExpect(subCard.locator(".localfb")).toBeHidden();
      const removeSub = subCard.getByRole("button", {
        name: "Remove subscription",
        exact: true,
      });
      const removeKey = keyCard.getByRole("button", {
        name: "Remove API key",
        exact: true,
      });
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      for (const width of [412, 1280]) {
        await page.setViewportSize({ width, height: 915 });
        await browserExpect(
          subCard.getByText("Signed in", { exact: true }),
        ).toBeVisible();
        await browserExpect(
          keyCard.getByText("Saved", { exact: true }),
        ).toBeVisible();
        for (const button of [removeSub, removeKey])
          await expectHitCorners(button);
        if (shots)
          await page.screenshot({
            path: `${shots}/openai-provider-${width}.png`,
          });
      }
      await removeKey.click();
      await browserExpect(
        keyCard.getByText("Not saved", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        subCard.getByText("Signed in", { exact: true }),
      ).toBeVisible();
      await chatgpt.edit.click();
      await chatgpt.saveKey();
      await removeSub.click();
      await browserExpect(
        subCard.getByText("Not signed in", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        keyCard.getByText("Saved", { exact: true }),
      ).toBeVisible();

      expect(requests.map((request) => [request.path, request.code])).toEqual([
        ["/claude/token", "claude-code"],
        ["/codex/token", "chatgpt-code"],
      ]);
      expect(requests[0]!.code_verifier).toBe(claude.state!);
      expect(errors).toEqual([]);
    } finally {
      for (const path of ["auth", "codex-auth"])
        await page.request.post(`${base}api/pi/${path}/logout`);
      await page.request.post(`${base}api/pi/codex-auth/api-key/remove`);
      await context.close();
      await tokens.stop(true);
    }
  },
  // Feature: #2932 response-header usage limits show under each login.
  async function test_usage_limits_from_response_headers(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const at = (hours: number) =>
      String(Math.floor(Date.now() / 1000) + hours * 3600);
    try {
      for (const path of ["auth", "codex-auth"])
        expect(
          (
            await page.request.post(`${base}api/pi/${path}/api-key`, {
              data: { key: "browser-test-inline-key" },
            })
          ).ok(),
        ).toBeTrue();
      const codex = `${base}api/pi/codex-auth`;
      expect((await page.request.post(`${codex}/login-url`)).ok()).toBeTrue();
      expect(
        (
          await page.request.post(`${codex}/token-json`, {
            data: { token: JSON.stringify(subscriptionToken()) },
          })
        ).ok(),
      ).toBeTrue();
      for (const [name, headers] of [
        [
          "anthropic-sse",
          {
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-unified-5h-status": "allowed",
            "anthropic-ratelimit-unified-5h-utilization": "0.62",
            "anthropic-ratelimit-unified-5h-reset": at(2),
            "anthropic-ratelimit-unified-7d-status": "allowed",
            "anthropic-ratelimit-unified-7d-utilization": "0.18",
            "anthropic-ratelimit-unified-7d-reset": at(72),
            "anthropic-ratelimit-unified-representative-claim": "five_hour",
            "anthropic-ratelimit-unified-reset": at(2),
          },
        ],
        [
          "openai-codex-sse",
          {
            "x-codex-primary-used-percent": "41",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": at(1),
            "x-codex-secondary-used-percent": "7",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-at": at(120),
          },
        ],
      ] as const) {
        const chat = await context.newPage();
        const chatErrors = captureErrors(chat);
        const seeded = await chat.request.post(
          `${base}__browser-test/seed-provider-replay`,
          { data: { name, headers } },
        );
        const { agent } = await seeded.json();
        await chat.goto(`${base}#agent=${agent}`);
        await chat.locator("#input").fill("Public usage message.");
        await chat.locator("#send").click();
        await chat.getByText("RECORDED_PROVIDER_OK", { exact: true }).waitFor();
        await browserExpect(chat.locator("#send.stop")).toHaveCount(0);
        const status = await chat.request.post(
          `${base}__browser-test/provider-replay-status`,
          { data: { agent, close: true } },
        );
        expect(await status.json()).toEqual({ requests: 1, failures: [] });
        expect(chatErrors).toEqual([]);
        await chat.close();
      }
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.locator("#settings-btn").click();
      await page.locator('#settings-nav button[data-cat="providers"]').click();
      await browserExpect(
        page.getByRole("button", { name: /^Claude / }),
      ).toBeVisible();
      await browserExpect(page.locator("dialog[open]")).toHaveCount(0);
      const time = String.raw`(?:\w{3} )?\d\d:\d\d`;
      for (const title of ["Claude", "OpenAI", "OpenRouter", "Gemini"]) {
        await closeDetails(page);
        await openDetail(page, new RegExp(`^${title} `));
        const section = page.getByRole("region", { name: title, exact: true });
        await browserExpect(section).toBeVisible();
        if (title === "OpenAI") {
          await browserExpect(
            section.getByRole("button", {
              name: "Replace API key",
              exact: true,
            }),
          ).toBeVisible();
          await browserExpect(
            section.getByRole("button", {
              name: "Remove API key",
              exact: true,
            }),
          ).toBeVisible();
          continue;
        }
        await browserExpect(
          section.getByRole("button", { name: "API key", exact: true }),
        ).toBeVisible();
        if (title === "Gemini") {
          await section
            .getByRole("button", { name: "API key", exact: true })
            .click();
          const input = section.getByLabel("Gemini API key");
          await browserExpect(input).toBeFocused();
          await browserExpect(input).toHaveAttribute("type", "password");
          await input.fill("browser-test-gemini-key");
          const logout = section.getByRole("button", {
            name: "Log out",
            exact: true,
          });
          const reopen = async (status: RegExp) => {
            await closeDetails(page);
            await page.locator("#settings-close").click();
            await browserExpect(page.locator("#settings-overlay")).toBeHidden();
            await page.locator("#settings-btn").click();
            await page
              .locator('#settings-nav button[data-cat="providers"]')
              .click();
            await openDetail(page, status);
          };
          await section
            .getByRole("button", { name: "Save key", exact: true })
            .click();
          await browserExpect(logout).toBeVisible();
          await reopen(/^Gemini API key · signed in$/);
          await browserExpect(logout).toBeVisible();
          await logout.click();
          await browserExpect(logout).toHaveCount(0);
          await reopen(/^Gemini Not signed in$/);
          await browserExpect(
            section.getByRole("button", { name: "API key", exact: true }),
          ).toBeVisible();
          await browserExpect(logout).toHaveCount(0);
        }
        if (title === "Claude") {
          await browserExpect(
            section.getByRole("button", { name: /^Subscription/ }),
          ).toBeVisible();
          await browserExpect(
            section.getByRole("button", { name: "Log out", exact: true }),
          ).toBeVisible();
        }
      }
      await closeDetails(page);
      for (const width of [1280, 412]) {
        await page.setViewportSize({ width, height: 915 });
        for (const [title, left] of [
          ["Claude", ["38", "82"]],
          ["OpenAI", ["59", "93"]],
        ] as const) {
          await closeDetails(page);
          const section = page.getByRole("region", {
            name: title,
            exact: true,
          });
          await browserExpect(section).toBeHidden();
          await openDetail(page, new RegExp(`^${title} `));
          await browserExpect(
            page.getByRole("dialog", { name: title, exact: true }),
          ).toBeVisible();
          if (width === 412) await expectModalSheet(page, title);
          await browserExpect(section.locator(".usage-name")).toHaveText([
            "5-hour",
            "Weekly",
          ]);
          await browserExpect(section.locator(".usage-text")).toHaveText(
            left.map(
              (percent) => new RegExp(`^${percent}% left, resets ${time}$`),
            ),
          );
          expect(
            await section
              .getByRole("progressbar")
              .evaluateAll((bars) =>
                bars.map((bar) => bar.getAttribute("aria-valuenow")),
              ),
          ).toEqual([...left]);
          await browserExpect(
            section.locator(".usage-limits .hint"),
          ).toHaveText(new RegExp(`^As of ${time}$`));
        }
      }
      await expectModalSheet(page, "OpenAI");
      const openai = page.getByRole("region", { name: "OpenAI", exact: true });
      const counters = openai.locator(".usage-text");
      const beforeRemoval = await counters.allTextContents();
      await openai
        .getByRole("button", { name: "Remove API key", exact: true })
        .click();
      await browserExpect(
        openai.getByText("Not saved", { exact: true }),
      ).toBeVisible();
      await browserExpect(counters).toHaveText(beforeRemoval);
      await openai
        .getByRole("button", { name: "Add API key", exact: true })
        .click();
      await openai
        .getByLabel("OpenAI API key")
        .fill("browser-test-platform-key");
      await openai
        .getByRole("button", { name: "Save key", exact: true })
        .click();
      await browserExpect(
        openai.getByText("Saved", { exact: true }),
      ).toBeVisible();
      await browserExpect(counters).toHaveText(beforeRemoval);
      for (const counter of await counters.all())
        await browserExpect(counter).toBeVisible();
      await page
        .getByRole("button", { name: "Close OpenAI", exact: true })
        .click();
      await openDetail(page, /^Claude /);
      const claude = page.getByRole("region", { name: "Claude", exact: true });
      await claude
        .getByRole("button", { name: "API key", exact: true })
        .click();
      const key = claude.getByLabel("Anthropic API key");
      await key.fill("unsaved-test-key");
      await page.setViewportSize({ width: 1280, height: 915 });
      await browserExpect(
        page.getByRole("button", { name: "Back to Providers", exact: true }),
      ).toBeVisible();
      await browserExpect(page.locator("dialog:modal")).toHaveCount(0);
      await browserExpect(key).toBeVisible();
      await browserExpect(key).toHaveValue("unsaved-test-key");
      expect(errors).toEqual([]);
    } finally {
      for (const path of ["auth", "codex-auth"])
        await page.request.post(`${base}api/pi/${path}/logout`);
      await page.request.post(`${base}api/pi/codex-auth/api-key/remove`);
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["settings-sign-in", tests]]);
