import { test_backend_client } from "./test_backend_client";
import { expect } from "bun:test";
import { EventEmitter, once } from "node:events";
import {
  ROOT,
  captureErrors,
  conversationRead,
  gotoRoot,
  mockConversation,
  rootAgentId,
  runBrowserTests,
  themeColors,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";
import { fillIconSlots } from "../../src/web/static";

const t = (id: string, ask: string, reply: string, cursor = 0): any => ({
  turn_id: id,
  cursor,
  started_at: 1,
  ended_at: 2,
  open: false,
  status: "idle",
  partial: false,
  summary: {
    tools: 0,
    shell: 0,
    read_files: 0,
    edit_files: 0,
    added: 0,
    removed: 0,
    write_files: 0,
    agents: 0,
    searches: 0,
    web: 0,
    prs: [],
    truncated: false,
  },
  segments: [
    {
      user: [
        {
          kind: "user",
          offset: cursor + 10,
          role: "user",
          content: ask,
          ts: 1,
        },
      ],
      tools: [],
      assistant: {
        kind: "assistant",
        offset: cursor + 90,
        role: "assistant",
        content: reply,
        usage: { input: 120, output: 40, cacheRead: 900, cacheWrite: 60 },
      },
      summary: {
        tools: 0,
        shell: 0,
        read_files: 0,
        edit_files: 0,
        added: 0,
        removed: 0,
        write_files: 0,
        agents: 0,
        searches: 0,
        web: 0,
        prs: [],
        truncated: false,
      },
    },
  ],
});
const staleShell = async () =>
  (
    await fillIconSlots(
      String(await Bun.file(`${ROOT}/web/index.html`).text()),
      `${ROOT}/web/icons.ts`,
    )
  )
    .replaceAll("__APP__", "Recurse")
    .replaceAll("__VERSION__", "browser-e2e-old");
const countApi = (
  counts: Record<string, number>,
  base: string,
  url: string,
) => {
  const path = url.split("?")[0];
  if (path === `${base}api/version`) counts.version++;
  else if (path === `${base}api/tree`) counts.tree++;
  else if (path === `${base}api/conversations/main`) counts.conversation++;
  else if (path === base) counts.root++;
};

async function test_stale_shell_recovers(browser: any, base: string) {
  const stale = await staleShell();
  const version = ((await (await fetch(`${base}api/version`)).json()) as any)
    .version;
  for (const [viewport, mobile, touch] of [
    [{ width: 390, height: 844 }, true, true],
    [{ width: 1280, height: 800 }, false, false],
  ] as const) {
    const context = await browser.newContext({
      viewport,
      isMobile: mobile,
      hasTouch: touch,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    let first = true;
    await page.route(base, (route: any) => {
      if (first) {
        first = false;
        return route.fulfill({
          status: 200,
          body: stale,
          contentType: "text/html",
        });
      }
      return route.continue();
    });
    await page.route(`${base}api/settings/theme`, () => {});
    await gotoRoot(page, base);
    await page.waitForURL(`${base}?_recurse_generation=${version}**`);
    await page.locator(".agent").first().waitFor();
    await page.waitForFunction(
      "!document.querySelector('#messages')?.classList.contains('stale')",
    );
    await visibleAndUncovered(page, "#messages");
    await visibleAndUncovered(page, "#input");
    await page.locator("#input").fill("upgrade stays visible");
    expect(await page.locator("#input").inputValue()).toBe(
      "upgrade stays visible",
    );
    expect(errors).toEqual([]);
    await context.close();
  }
}

async function test_still_stale_shell_offers_a_themed_retry(
  browser: any,
  base: string,
) {
  const version = ((await (await fetch(`${base}api/version`)).json()) as any)
    .version;
  const stale = (await (await fetch(base)).text()).replaceAll(
    `v=${version}`,
    "v=browser-e2e-old",
  );
  const root = new URL(base).pathname;
  for (const [viewport, mobile] of [
    [{ width: 412, height: 915 }, true],
    [{ width: 1280, height: 800 }, false],
  ] as const) {
    const context = await browser.newContext({
      viewport,
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.route(
      (url: URL) => url.pathname === root,
      (route: any) =>
        route.fulfill({ status: 200, body: stale, contentType: "text/html" }),
    );
    await gotoRoot(page, base);
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "The app update did not finish." });
    await notice.waitFor();
    expect(new URL(page.url()).searchParams.get("_recurse_generation")).toBe(
      version,
    );
    const [panel, text, warn, border] = await themeColors(
      page,
      "var(--panel)",
      "var(--text)",
      "var(--warn)",
      "var(--border)",
    );
    expect(
      await notice.evaluate((el: any) => {
        const style = (globalThis as any).getComputedStyle(el);
        return [style.backgroundColor, style.color, style.borderTopColor];
      }),
    ).toEqual([panel, text, warn]);
    const retry = notice.getByRole("button", { name: "Retry update" });
    const [box, inner] = await Promise.all([
      notice.boundingBox(),
      retry.boundingBox(),
    ]);
    expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width);
    expect(
      await retry.evaluate((el: any) => {
        const style = (globalThis as any).getComputedStyle(el);
        return [style.borderTopColor, style.color, style.minHeight];
      }),
    ).toEqual([border, text, mobile ? "44px" : "32px"]);
    await retry.click();
    await page.waitForURL(/_recurse_retry=/);
    await notice.waitFor();
    expect(errors).toEqual([]);
    await context.close();
  }
}

async function test_superseded_conversation_cannot_overwrite_newer_poll(
  browser: any,
  base: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(`(() => {
    const nativeFetch = window.fetch.bind(window); window.__conversationRaceCalls = 0; const path = "/api/conversations/${rootAgentId()}";
    window.fetch = async (input, init) => { const p = new URL(typeof input === "string" ? input : input.url, location.href).pathname; if (p !== path) return nativeFetch(input, init); const call = ++window.__conversationRaceCalls; const response = await nativeFetch(input, init); const data = await response.json(); data.title = call === 1 ? "Superseded conversation" : "Current conversation"; data.status = "running"; data.msg_count = call === 1 ? 1 : 2; data.window_cursor = 1; data.turns = [{turn_id:"poll-race-turn",cursor:1,started_at:1,ended_at:null,open:true,status:"open",summary:null,partial:false,segments:[{user:call===1?[]:[{kind:"user",offset:1,role:"user",content:"Run it"}],tools:[],summary:null,assistant:call===1?null:{kind:"assistant",offset:2,role:"assistant",id:"111111111111111111111111",content:"Current completed reply"}}]}]; data.draft = call === 1 ? {turn:"poll-race-turn",message_id:"111111111111111111111111",text:"STALE PARTIAL DRAFT",tools:0} : null; if(call===1){setTimeout(()=>dispatchEvent(new Event("focus")),10); await new Promise((r)=>setTimeout(r,900)); window.__staleResponseComplete=true;} return new Response(JSON.stringify(data),{status:response.status,headers:{"Content-Type":"application/json"}}); };
  })()`);
  const page = await context.newPage();
  const errors = captureErrors(page);
  await mockConversation(page, base, rootAgentId(), () => ({
    id: rootAgentId(),
    status: "running",
    rows: [
      {
        id: "race-user",
        kind: "text",
        role: "user",
        origin: "operator",
        text: "Run it",
      },
      {
        id: "race-answer",
        kind: "text",
        role: "assistant",
        text: "Current completed reply",
      },
    ],
  }));
  await page.route(`${base}api/tree`, (route: any) =>
    route.fulfill({
      json: [
        {
          id: rootAgentId(),
          parent: null,
          title: "Current conversation",
          kind: null,
          status: "running",
          updated: 2,
          children: 0,
          queued: 0,
          preview: "",
          muted: false,
          safety_off: false,
        },
      ],
    }),
  );
  await gotoRoot(page, base);
  await page.waitForFunction("window.__conversationRaceCalls >= 2");
  await page
    .locator("#conv-title")
    .filter({ hasText: "Current conversation" })
    .waitFor();
  await page.waitForFunction("window.__staleResponseComplete");
  expect(await page.locator("#conv-title").innerText()).toBe(
    "Current conversation",
  );
  expect(
    await page
      .locator(".turn.current .msg.assistant > .content")
      .allInnerTexts(),
  ).toEqual(["Current completed reply"]);
  expect(await page.locator("#messages").innerText()).not.toContain(
    "STALE PARTIAL DRAFT",
  );
  expect(errors).toEqual([]);
  await context.close();
}

async function test_poll_omission_cannot_blank_a_delivered_message_or_reply(
  browser: any,
  base: string,
) {
  const id = rootAgentId();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(`(() => {
    const nativeFetch=window.fetch.bind(window); const path="/api/conversations/${id}"; window.__deliveryApplied=false; window.__conversationViews=0;
    window.fetch=async(input,init)=>{const req=typeof input === "string"?null:input; const url=new URL(typeof input === "string"?input:input.url,location.href); const method=(init?.method||req?.method||"GET").toUpperCase(); if(url.pathname===path+"/deliver"&&method==="POST"){window.__deliveryApplied=true;return new Response(JSON.stringify({message_id:"delivered-message",steer:true}),{status:200,headers:{"Content-Type":"application/json"}})} if(url.pathname===path+"/events"){const d=window.__deliveryApplied;const b=d?[{id:"delivered-message",kind:"text",role:"user",origin:"operator",text:"Delivered follow-up",order:3,offset:210}]:[{id:"original",kind:"text",role:"user",origin:"operator",text:"Original question",order:0,offset:110},{id:"durable-reply",kind:"text",role:"assistant",text:"Reply that must stay visible",order:1,offset:130},{id:"agent-report",kind:"text",role:"user",origin:"agent",sender:"reaped-agent",text:"Agent report that must stay visible",order:2,offset:140}];return new Response("retry: 3000\\n\\nevent: snapshot\\ndata: "+JSON.stringify({status:"ready",instance_id:"retention",revision:d?2:1,blocks:b,older:false,newer:false})+"\\n\\n",{headers:{"Content-Type":"text/event-stream"}})} if(url.pathname===path+"/view"){const d=window.__deliveryApplied;const b=d?[{id:"delivered-message",kind:"text",role:"user",origin:"operator",text:"Delivered follow-up",order:3,offset:210}]:[{id:"original",kind:"text",role:"user",origin:"operator",text:"Original question",order:0,offset:110},{id:"durable-reply",kind:"text",role:"assistant",text:"Reply that must stay visible",order:1,offset:130},{id:"agent-report",kind:"text",role:"user",origin:"agent",text:"Agent report that must stay visible",order:2,offset:140}];return new Response(JSON.stringify({status:"ready",instance_id:"retention",revision:d?2:1,blocks:b,older:false,newer:false}),{headers:{"Content-Type":"application/json"}})} const response=await nativeFetch(input,init);if(url.pathname!==path||method!=="GET")return response;const data=await response.json();const d=window.__deliveryApplied;window.__conversationViews++;Object.assign(data,{status:"running",active_run:"current-run",msg_count:d?3:2,turns:[{turn_id:"current-turn",cursor:100,started_at:1,ended_at:null,open:true,status:"open",partial:false,summary:{tools:1,shell:0,read_files:1,edit_files:0,added:0,removed:0,write_files:0,agents:0,searches:0,web:0,prs:[],truncated:false},segments:[{user:d?[]:[{kind:"user",offset:110,role:"user",content:"Original question"}],tools:[{kind:"tool",offset:120,seq:1,status:"ok",stat:{kind:"read",lines:1}}],assistant:d?null:{kind:"assistant",offset:130,role:"assistant",id:"durable-reply",content:"Reply that must stay visible"},summary:null},{user:d?[]:[{kind:"user",offset:140,role:"user",id:"agent-report",content:"Agent report that must stay visible",from:"reaped-agent",origin:"agent"}],tools:[],assistant:null,summary:null},...(d?[{user:[{kind:"user",offset:210,role:"user",content:"Delivered follow-up",id:"delivered-message"}],tools:[],assistant:null,summary:null}]:[])]}],window_cursor:100,pi_window_cursor:"stable-pi-window",pi_history_status:"ready",thread_generation:"stable-thread",message_log_generation:1,draft:d?{turn:"current-turn",text:"",tools:0}:null,pending:d?[]:[{role:"user",id:"agent-report",content:"Agent report that must stay visible",from:"reaped-agent",origin:"agent",steer:true,delivery_state:"materialized"}]});return new Response(JSON.stringify(data),{status:response.status,headers:{"Content-Type":"application/json"}})};
  })()`);
  const page = await context.newPage();
  const errors = captureErrors(page);
  await page.route(`${base}api/tree`, (route: any) =>
    route.fulfill({
      json: [
        {
          id,
          parent: null,
          title: "Reply retention",
          kind: null,
          status: "running",
          updated: 2,
          children: 0,
          queued: 0,
          preview: "",
          muted: false,
          safety_off: false,
        },
      ],
    }),
  );
  await gotoRoot(page, base);
  const reply = page.locator(".msg.assistant .content", {
    hasText: "Reply that must stay visible",
  });
  await reply.waitFor();
  await page
    .locator(".activity-boundary .activity-group-toggle")
    .last()
    .click();
  const message = page.locator(".agent-message.inline");
  await message.locator(".agent-message-row").click();
  await message
    .locator(".agent-message-content", {
      hasText: "Agent report that must stay visible",
    })
    .waitFor();
  await page.evaluate(
    `(()=>{const text='Agent report that must stay visible';const present=()=>[...document.querySelectorAll('.agent-message-content')].some(n=>n.textContent?.includes(text));window.__deliveredMessageMissing=false;new MutationObserver(()=>window.__deliveredMessageMissing ||= !present()).observe(document.querySelector('#messages'),{childList:true,subtree:true})})()`,
  );
  const before = await page.evaluate("window.__conversationViews");
  await page.locator("#input").fill("Delivered follow-up");
  await page.locator("#input").press("Enter");
  await page.waitForFunction(
    `window.__deliveryApplied&&window.__conversationViews>${before}`,
  );
  await page.locator(".msg.user", { hasText: "Delivered follow-up" }).waitFor();
  await reply.waitFor();
  await message
    .locator(".agent-message-content", {
      hasText: "Agent report that must stay visible",
    })
    .waitFor({ timeout: 10000 });
  expect(await reply.count()).toBe(1);
  expect(await message.count()).toBe(1);
  expect(await page.locator(".msg.user.accepted.agent").count()).toBe(0);
  expect(await page.evaluate("!window.__deliveredMessageMissing")).toBeTrue();
  expect(errors).toEqual([]);
  await context.close();
}

// Regression: #2743 a pre-offline probe success must not hide offline recovery.
async function test_connection_monitor_precedes_authoritative_read(
  browser: any,
  base: string,
) {
  const stale = (await staleShell())
    .replaceAll(
      "/static/app.js?v=browser-e2e-old",
      "/static/app.js?v=browser-e2e-current",
    )
    .replace(
      "/static/app.css?v=browser-e2e-old",
      "/static/app.css?v=browser-e2e-current",
    );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(
    `(()=>{if(localStorage.getItem("recurse.treeMode")===null)localStorage.setItem("recurse.treeMode","reject");if(localStorage.getItem("recurse.conversationMode")===null)localStorage.setItem("recurse.conversationMode","allow");window.__treeAttempts=0;window.__conversationAttempts=0;const unavailable=()=>Promise.resolve(new Response(JSON.stringify({detail:"unavailable"}),{status:503,headers:{"Content-Type":"application/json"}}));const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const p=new URL(typeof input==="string"?input:input.url,location.href).pathname;if(p==="/api/tree"){window.__treeAttempts++;const m=localStorage.getItem("recurse.treeMode");if(m==="reject")return Promise.reject(new TypeError("tree unavailable"));if(m==="503")return unavailable()}else if(/^\\/api\\/conversations\\/[^/]+$/.test(p)){window.__conversationAttempts++;const m=localStorage.getItem("recurse.conversationMode");if(m==="503")return unavailable();if(m==="delay-success"){window.__delayedConversationStarted=true;return new Promise((r,j)=>setTimeout(()=>nativeFetch(input,init).then(response=>{window.__delayedConversationComplete=true;r(response)},j),900))}}return nativeFetch(input,init)}})()`,
  );
  const page = await context.newPage();
  const errors = captureErrors(page);
  let first = true,
    versionAvailable = true;
  await page.route(base, (route: any) => {
    if (first) {
      first = false;
      return route.fulfill({
        status: 200,
        body: stale,
        contentType: "text/html",
      });
    }
    return route.continue();
  });
  let releaseVersion!: () => void;
  const versionHeld = new Promise<void>((resolve) => {
    releaseVersion = resolve;
  });
  let versionStarted!: () => void;
  const versionRequested = new Promise<void>((resolve) => {
    versionStarted = resolve;
  });
  let versionRequests = 0;
  await page.route(base + "api/version", async (route: any) => {
    const available = versionAvailable;
    if (++versionRequests === 2) {
      versionStarted();
      await versionHeld;
    }
    return available
      ? route.fulfill({
          json: { version: "browser-e2e-current" },
          headers: { "Cache-Control": "no-store" },
        })
      : route.fulfill({ status: 503, json: { detail: "unavailable" } });
  });
  const monitorResponse = page.waitForResponse(base + "api/version");
  await gotoRoot(page, base);
  await (await monitorResponse).finished();
  await page.waitForFunction("window.__treeAttempts>=1");
  expect(await page.evaluate("window.__conversationAttempts")).toBe(0);
  expect(await page.locator("#messages").isVisible()).toBeTrue();
  await versionRequested;
  versionAvailable = false;
  await page.evaluate("dispatchEvent(new Event('offline'))");
  releaseVersion();
  await page
    .locator('#connection-status.on[data-state="offline"] button')
    .waitFor();
  await page.locator("#connection-status button").click();
  await page.waitForFunction(
    "!document.querySelector('#connection-status button').disabled",
  );
  const wakeResponse = page.waitForResponse(base + "api/version");
  versionAvailable = true;
  await page.evaluate(
    "dispatchEvent(new Event('online'));dispatchEvent(new Event('focus'));dispatchEvent(new PageTransitionEvent('pageshow'))",
  );
  await (await wakeResponse).finished();
  const ta = await page.evaluate("window.__treeAttempts");
  await page.evaluate("localStorage.setItem('recurse.treeMode','503')");
  await page.waitForFunction(`window.__treeAttempts>${ta}`);
  const ca = await page.evaluate("window.__conversationAttempts");
  await page.evaluate(
    "localStorage.setItem('recurse.treeMode','allow');localStorage.setItem('recurse.conversationMode','503')",
  );
  await page.waitForFunction(`window.__conversationAttempts>${ca}`);
  await page.evaluate(
    "localStorage.setItem('recurse.conversationMode','delay-success')",
  );
  await page.waitForFunction("window.__delayedConversationStarted");
  await page.evaluate(
    "localStorage.setItem('recurse.conversationMode','503');dispatchEvent(new Event('focus'))",
  );
  await page.waitForFunction("window.__delayedConversationComplete");
  await page.evaluate(
    "localStorage.setItem('recurse.conversationMode','allow')",
  );
  await page.waitForURL(`${base}?_recurse_generation=browser-e2e-current**`);
  await page.locator(".agent").first().waitFor();
  await page.waitForFunction("location.search === ''");
  await page.locator("#input").waitFor();
  expect(errors).toEqual([]);
  await context.close();
}

async function test_deferred_generation_recovery_keeps_chat_usable(
  browser: any,
  base: string,
) {
  const stale = (await staleShell())
    .replaceAll(
      "/static/app.js?v=browser-e2e-old",
      "/static/app.js?v=browser-e2e-current",
    )
    .replace(
      "/static/app.css?v=browser-e2e-old",
      "/static/app.css?v=browser-e2e-current",
    );
  const recovery = {
    version: 1,
    input: "restored unsent message",
    attachments: [
      {
        url: "/api/attachments/restored.png",
        isImage: true,
        filename: "restored.png",
        owner: { kind: "owner", id: "main" },
      },
    ],
    draft: null,
    jobs: [
      {
        draft: false,
        convId: "main",
        content: "restored failed send",
        waitForIndex: -1,
      },
    ],
  };
  for (const [_name, viewport, mobile, touch] of [
    ["phone", { width: 390, height: 844 }, true, true],
    ["desktop", { width: 1280, height: 800 }, false, false],
  ] as const) {
    const context = await browser.newContext({
      viewport,
      isMobile: mobile,
      hasTouch: touch,
    });
    await context.addInitScript(
      `(()=>{sessionStorage.setItem("recurse.authRecovery.v1",${JSON.stringify(JSON.stringify(recovery))});localStorage.setItem("recurse.lastAgent","main");localStorage.setItem("recurse.staleGeneration","obsolete");const nativeFetch=window.fetch.bind(window);let calls=0;window.fetch=(input,init)=>{const p=new URL(typeof input==="string"?input:input.url,location.href).pathname;if(p!=="/api/tree")return nativeFetch(input,init);calls++;if(calls===1)setTimeout(()=>{dispatchEvent(new Event("focus"));dispatchEvent(new PageTransitionEvent("pageshow"))},10);const delay=calls===1?200:calls===2?900:0;return new Promise((r,j)=>setTimeout(()=>nativeFetch(input,init).then(r,j),delay))}})()`,
    );
    const page = await context.newPage();
    const errors = captureErrors(page);
    const counts = { version: 0, tree: 0, conversation: 0, root: 0 };
    let first = true,
      current = "browser-e2e-current";
    await page.on("request", (r: any) => countApi(counts, base, r.url()));
    await page.route(base, (r: any) => {
      if (first) {
        first = false;
        return r.fulfill({
          status: 200,
          body: stale,
          contentType: "text/html",
        });
      }
      return r.continue();
    });
    await page.route(base + "api/version", (r: any) =>
      r.fulfill({
        json: { version: current },
        headers: { "Cache-Control": "no-store" },
      }),
    );
    await page.route(base + "api/conversations/main/deliver", (r: any) =>
      r.request().method() === "POST"
        ? r.fulfill({ json: { ok: true } })
        : r.continue(),
    );
    await gotoRoot(page, base);
    await page.locator("#update-status.on button").waitFor();
    expect(counts.tree).toBeGreaterThanOrEqual(2);
    expect(counts.conversation).toBeGreaterThanOrEqual(1);
    await page.locator(".agent").first().waitFor();
    await page.locator("#send-status.error").waitFor();
    await visibleAndUncovered(page, "#messages");
    await visibleAndUncovered(page, "#input");
    expect(await page.locator("#input").inputValue()).toBe(
      "restored unsent message",
    );
    expect(await page.locator("#attachments .attach-chip").count()).toBe(1);

    expect(counts.root).toBe(1);
    expect(await page.locator("#input").inputValue()).toBe(
      "restored unsent message",
    );
    await visibleAndUncovered(page, "#input");
    await page.evaluate(
      "for(let i=0;i<20;i++){dispatchEvent(new Event('focus'));dispatchEvent(new PageTransitionEvent('pageshow'))}",
    );
    await page.locator("#update-status button").click();
    await page.waitForFunction(
      "document.querySelector('#update-status.on')?.textContent?.includes('send or clear unsent work first')",
    );
    expect(counts.root).toBe(1);
    await page.locator("#input").fill("");
    await page.locator("#attachments .rm").click();
    await page.locator("#send-status.error").click();
    await page
      .locator(".msg.user.pending")
      .filter({ hasText: "restored failed send" })
      .waitFor();
    await page.waitForFunction(
      "!document.querySelector('#send-status')?.classList.contains('show')",
    );
    await page.locator("#update-status button").click();
    await page.waitForURL(`${base}?_recurse_generation=browser-e2e-current**`);
    await page.locator(".agent").first().waitFor();
    await page.waitForFunction("location.search === ''");
    await visibleAndUncovered(page, "#messages");
    await visibleAndUncovered(page, "#input");
    expect(counts.root).toBe(2);
    expect(await page.locator("#update-status").isVisible()).toBeFalse();
    expect(errors).toEqual([]);
    await context.close();
  }
}

async function test_focused_conversation_outranks_background_reads(
  browser: any,
  base: string,
) {
  const longThread = (id: string, title: string, reply: string) => ({
    id,
    title,
    parent: id === "main" ? null : "main",
    status: "idle",
    msg_count: 40,
    window_cursor: 100,
    turns: Array.from({ length: 20 }, (_, i) =>
      t(`t${i}`, `Ask ${i}`, `${reply} ${i}`, 100 * (i + 1)),
    ),
  });
  const tree = [
    {
      id: "main",
      parent: null,
      updated: 1,
      title: "Coordinator",
      kind: null,
      status: "idle",
      children: 1,
      queued: 0,
      preview: "",
      muted: false,
    },
    {
      id: "kid",
      parent: "main",
      updated: 1,
      title: "Neighbour",
      kind: null,
      status: "idle",
      children: 0,
      queued: 0,
      preview: "",
      muted: false,
    },
  ];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await context.addInitScript(
    `(()=>{window.__order=[];const real=window.fetch.bind(window);window.fetch=(input,init)=>{const u=new URL(typeof input==="string"?input:input.url,location.href),p=u.pathname+(u.search||"");if(p.startsWith("/api"))window.__order.push(p);return real(input,init)}})()`,
  );
  await page.route(base + "api/tree", (r: any) => r.fulfill({ json: tree }));
  await mockConversation(page, base, "main", () =>
    longThread("main", "Coordinator", "Coordinator reply"),
  );
  await mockConversation(page, base, "kid", () =>
    longThread("kid", "Neighbour", "Neighbour reply"),
  );
  const held: any[] = [];
  await page.route(base + "api/artifacts**", (r: any) => held.push(r));
  await page.route(base + "api/conversations/*/diff**", (r: any) =>
    held.push(r),
  );
  const aborted: string[] = [];
  page.on("requestfailed", (r: any) => aborted.push(r.url()));
  await gotoRoot(page, base);
  await page
    .locator("#messages")
    .filter({ hasText: "Coordinator reply 19" })
    .waitFor();
  const cold: any[] = await page.evaluate("window.__order");
  const reads = cold.filter((p) => p.includes("/api/conversations/"));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads[0].startsWith("/api/conversations/main")).toBeTrue();
  const main = reads.find((p) => p.startsWith("/api/conversations/main?"));
  expect(main).toContain("focused=1");
  expect(main).toContain("switch_trace=");
  expect(main).toContain("client_dispatch_ms=");
  const focusedAt = cold.indexOf(main);
  for (const p of cold.slice(0, focusedAt)) expect(p).not.toContain("/diff");
  expect(cold.findIndex((p: string) => p.startsWith("/api/tree"))).toBeLessThan(
    focusedAt,
  );
  const coldLength = cold.length;
  await page.waitForFunction((start: number) => {
    const r = (globalThis as any).__order.slice(start);
    return (
      r.some((p: string) => p.startsWith("/api/tree")) &&
      r.some((p: string) => p.includes("/api/conversations/main?"))
    );
  }, coldLength);
  const later = (await page.evaluate("window.__order")).slice(coldLength);
  const laterFocused = later.find((p: string) =>
    p.includes("/api/conversations/main?"),
  );
  expect(later.indexOf(laterFocused)).toBeLessThan(
    later.findIndex((p: string) => p.startsWith("/api/tree")),
  );
  await page.waitForFunction(
    "window.__order.some(p=>p.startsWith('/api/artifacts'))",
  );
  await page.evaluate("window.__order=[]");
  const backgroundAborted = page.waitForEvent("requestfailed", {
    predicate: (request: any) =>
      request.url().includes("agent=main") ||
      request.url().includes("/main/diff"),
    timeout: 15_000,
  });
  const timing = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const browser = globalThis as any;
        const doc = browser.document;
        const messages = doc.querySelector("#messages");
        const started = browser.performance.now();
        const observer = new browser.MutationObserver(() => {
          if (messages.innerText.includes("Neighbour reply 19")) {
            observer.disconnect();
            resolve(browser.performance.now() - started);
          }
        });
        observer.observe(messages, { childList: true, subtree: true });
        doc.querySelector('.agent[data-id="kid"]').click();
      }),
  );
  const switched: any[] = await page.evaluate("window.__order");
  const kid = switched.find((p) => p.startsWith("/api/conversations/kid?"));
  expect(kid).toContain("focused=1");
  expect(kid).toContain("switch_trace=");
  expect(kid).toContain("client_dispatch_ms=");
  console.log(`Focused conversation paint: ${Number(timing)}ms`);
  await backgroundAborted;
  expect(
    aborted.some((u) => u.includes("agent=main") || u.includes("/main/diff")),
  ).toBeTrue();
  expect(errors).toEqual([]);
  for (const r of held) await r.fulfill({ json: [] }).catch(() => {});
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function test_background_warming_waits_for_the_focused_read(
  browser: any,
  base: string,
) {
  const thread = {
    id: "main",
    title: "Coordinator",
    parent: null,
    status: "idle",
    msg_count: 6,
    window_cursor: 100,
    turns: Array.from({ length: 3 }, (_, i) =>
      t(`t${i}`, `Ask ${i}`, `Reply ${i}`, 100 * (i + 1)),
    ),
  };
  let polls = 0,
    neighbours = 1;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await page.addInitScript(
    `(()=>{window.__order=[];const real=window.fetch.bind(window);window.fetch=(input,init)=>{const u=new URL(typeof input==="string"?input:input.url,location.href),p=u.pathname+(u.search||"");if(p.startsWith('/api'))window.__order.push(p);return real(input,init)}})()`,
  );
  await mockConversation(page, base, "main", () => thread);
  const held: any[] = [];
  const heldEvents = new EventEmitter();
  await page.route(conversationRead(base, "main"), (r: any) => {
    held.push(r);
    heldEvents.emit("held");
  });
  await page.route(base + "api/tree", (r: any) => {
    polls++;
    return r.fulfill({
      json: [
        {
          id: "main",
          parent: null,
          updated: 1 + polls,
          title: "Coordinator",
          kind: null,
          status: "idle",
          children: neighbours,
          queued: 0,
          preview: "",
          muted: false,
        },
        ...Array.from({ length: neighbours }, (_, n) => ({
          id: `kid${n}`,
          parent: "main",
          updated: 1 + polls,
          title: `Kid ${n}`,
          kind: null,
          status: "idle",
          children: 0,
          queued: 0,
          preview: "",
          muted: false,
        })),
      ],
    });
  });
  await page.route(new RegExp(`${base}api/conversations/kid\\d$`), (r: any) =>
    r.fulfill({
      json: {
        id: "kid0",
        title: "Kid",
        parent: "main",
        status: "idle",
        kind: null,
        msg_count: 0,
        turns: [],
      },
    }),
  );
  await page.route(base + "api/artifacts**", (r: any) =>
    r.fulfill({ json: [] }),
  );
  await page.route(base + "api/conversations/*/diff**", (r: any) =>
    r.fulfill({ json: [] }),
  );
  const warm = async () =>
    (await page.evaluate("window.__order")).filter((p: string) =>
      p.startsWith("/api/conversations/kid"),
    );
  const release = async () => {
    while (held.length) {
      try {
        await held.pop().fulfill({ json: thread });
      } catch {}
    }
  };
  const initialTree = page.waitForResponse(base + "api/tree");
  await gotoRoot(page, base);
  await page.locator('.agent[data-id="kid0"]').waitFor();
  await (await initialTree).finished();
  expect(await warm()).toEqual([]);
  if (!held.length)
    await once(heldEvents, "held", { signal: AbortSignal.timeout(15_000) });
  await release();
  const focusedPollHeld = held.length
    ? Promise.resolve()
    : once(heldEvents, "held", { signal: AbortSignal.timeout(15_000) });
  await page.locator("#messages").filter({ hasText: "Reply 2" }).waitFor();
  await page.waitForFunction(
    "window.__order.some(p=>/^\\/api\\/conversations\\/kid\\d$/.test(p))",
  );
  await focusedPollHeld;
  expect(held.length).toBeGreaterThan(0);
  neighbours = 2;
  const updatedTree = page.waitForResponse(base + "api/tree");
  const wakeReadHeld = once(heldEvents, "held", {
    signal: AbortSignal.timeout(15_000),
  });
  await page.evaluate("window.__order=[];dispatchEvent(new Event('focus'))");
  await wakeReadHeld;
  await page.locator('.agent[data-id="kid1"]').waitFor();
  await (await updatedTree).finished();
  expect(await warm()).toEqual([]);
  await release();
  await page.waitForFunction(
    "window.__order.some(p=>p === '/api/conversations/kid1')",
  );
  expect(errors).toEqual([]);
  await release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

export const tests: BrowserTest[] = [
  test_backend_client,
  test_focused_conversation_outranks_background_reads,
  test_background_warming_waits_for_the_focused_read,
  test_stale_shell_recovers,
  test_still_stale_shell_offers_a_themed_retry,
  test_superseded_conversation_cannot_overwrite_newer_poll,
  test_poll_omission_cannot_blank_a_delivered_message_or_reply,
  test_connection_monitor_precedes_authoritative_read,
  test_deferred_generation_recovery_keeps_chat_usable,
];
if (import.meta.main) await runBrowserTests([["recovery", tests]]);
