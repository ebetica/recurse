// Settings section registry rebuilds controls on each open and on a change of
// the Recurse being configured (settings/target.ts). Each builder receives its
// fresh body and close callback.
import { $ } from "./dom.js";
import { jpost as homeJpost } from "./api.js";
import { setSettingsLabel, settingsClient } from "./settings/target.js";
import { backends } from "./backends/backend.js";
import {
  modelListStatusText,
  type ModelListUpdateStatus,
} from "./models/list-status.js";
import {
  clampReasoning,
  indexModels,
  reasoningChoices,
  THINKING_ORDER,
  type FinderModel,
  type IndexedModel,
} from "./models/finder.js";
import { createModelBox, type ModelBox } from "./models/finder-ui.js";
import { closeMobileSidebar, mobileSidebarOpen } from "./sidebar.js";
import { clearSkillsCache } from "./skills.js";
import { installFocusTrap, restoreFocus } from "./focus_trap.js";
import { buildThemeSection } from "./settings/theme.js";
import { buildBrandingSection } from "./settings/branding.js";
import { buildMcpStatus } from "./settings/mcp.js";
import { buildConnectedBackends } from "./settings/backends.js";
import { buildNotificationsSection } from "./settings/notifications.js";
import { buildUpdatesSection, showRelease } from "./settings/updates.js";

interface AuthStatus {
  configured?: boolean;
  label?: string;
  type?: string;
}
type CodeResult = AuthStatus & {
  fallback?: string;
  command: string;
};

// The repeated "read a {detail} error message off the response, else fall back"
// dance, in one place. Behaves exactly like the inlined version it replaces:
// a missing/blank detail or a non-JSON body yields the fallback string.
async function errDetail(r: Response, fallback: string): Promise<string> {
  try {
    return ((await r.json()) as { detail?: string }).detail || fallback;
  } catch {
    return fallback;
  }
}

type BuildFn = (body: HTMLElement, close: () => void) => void;
type Category = "account" | "appearance" | "auth" | "models" | "agents";
const CATEGORY_LABELS: Record<Category, string> = {
  account: "Account",
  appearance: "Appearance",
  auth: "Authentication",
  models: "Models",
  agents: "MCPs",
};
const settingsSections: { title: string; cat: Category; build: BuildFn }[] = [];
const settingsSection = (title: string, cat: Category, build: BuildFn) =>
  settingsSections.push({ title, cat, build });

// Scope chips to their section so stale backend replies change nothing.
const authChip = (body: HTMLElement) =>
  body.parentElement?.querySelector<HTMLElement>(".sec-head .state");
const markAuth = (body: HTMLElement, on: boolean, label?: string) => {
  const chip = authChip(body);
  if (!chip) return;
  chip.textContent = on ? "Logged in!" : "Not logged in";
  chip.title = label ?? "";
  chip.className = `state ${on ? "ok" : "off"}`;
};
const markAuthError = (body: HTMLElement) => {
  const chip = authChip(body);
  if (chip) {
    chip.textContent = "Couldn't check";
    chip.className = "state off";
  }
};

const settingsOverlay = $("#settings-overlay")!;
const settingsModal = $("#settings-modal")!;
const settingsNav = $("#settings-nav")!;

/** Mark which ends of the phone tab strip have tabs scrolled past them. */
function markNavEdges(): void {
  const hidden = settingsNav.scrollWidth - settingsNav.clientWidth;
  settingsNav.classList.toggle("more-start", settingsNav.scrollLeft > 1);
  settingsNav.classList.toggle("more-end", hidden - settingsNav.scrollLeft > 1);
}
settingsNav.addEventListener("scroll", markNavEdges, { passive: true });
new ResizeObserver(markNavEdges).observe(settingsNav);
let settingsReturnFocus: HTMLElement | null = null;
installFocusTrap(settingsModal);
const settingsBackend = $<HTMLSelectElement>("#settings-backend")!;
settingsBackend.onchange = () => {
  renderSettings(settingsBackend.value);
  markNavEdges();
};
export function openSettings() {
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  settingsReturnFocus =
    mobileSidebarOpen() && active?.closest("#sidebar")
      ? $("#menu-btn")
      : active;
  settingsBackend.replaceChildren(
    ...backends().map(({ label }) => {
      const option = document.createElement("option");
      option.value = label;
      option.textContent = label || "This Recurse";
      return option;
    }),
  );
  settingsBackend.hidden = backends().length < 2;
  renderSettings("");
  settingsOverlay.classList.add("on");
  closeMobileSidebar(true);
  markNavEdges();
  const first = $("#settings-nav")!.querySelector<HTMLElement>("button");
  if (first) setTimeout(() => first.focus(), 30);
}
const settingsRelease = $("#settings-release")!;
/** Build every section for one Recurse: "" is this one, else a remote label. */
function renderSettings(label: string) {
  setSettingsLabel(label);
  settingsBackend.value = label;
  void showRelease(settingsRelease, label);
  const pane = $("#settings-sections")!;
  const nav = $("#settings-nav")!;
  pane.textContent = "";
  nav.textContent = "";
  let current: Category | null = null;
  const cards: { cat: Category; el: HTMLElement }[] = [];
  const show = (cat: Category) => {
    if (current === cat) return;
    current = cat;
    for (const c of cards) c.el.hidden = c.cat !== cat;
    for (const btn of nav.querySelectorAll("button"))
      btn.classList.toggle("on", btn.dataset.cat === cat);
  };
  const cats = label
    ? (["auth", "models", "agents"] as const)
    : (["account", "appearance", "auth", "models", "agents"] as const);
  for (const cat of cats) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.cat = cat;
    btn.textContent = CATEGORY_LABELS[cat];
    btn.onclick = () => show(cat);
    nav.appendChild(btn);
    const card = document.createElement("div");
    card.className = "settings-cat";
    card.hidden = true;
    for (const s of settingsSections.filter((x) => x.cat === cat)) {
      const sec = document.createElement("section");
      sec.className = "settings-section";
      const head = document.createElement("div");
      head.className = "sec-head";
      const h = document.createElement("h3");
      h.textContent = s.title;
      head.append(h);
      if (
        [
          "Claude auth",
          "OpenAI auth",
          "Muse subscription",
          "OpenRouter auth",
        ].includes(s.title)
      ) {
        const chip = document.createElement("span");
        chip.textContent = "…";
        chip.className = "state off";
        head.append(chip);
      }
      const body = document.createElement("div");
      sec.append(head, body);
      card.appendChild(sec);
      s.build(body, closeSettings);
    }
    pane.appendChild(card);
    cards.push({ cat, el: card });
  }
  show(cats[0]);
}
export function closeSettings(): boolean {
  if (!settingsOverlay.classList.contains("on")) return false;
  settingsOverlay.classList.remove("on");
  restoreFocus(settingsReturnFocus);
  settingsReturnFocus = null;
  return true;
}
export function settingsOpen(): boolean {
  return settingsOverlay.classList.contains("on");
}
$("#settings-btn")!.onclick = openSettings;
$("#settings-close")!.onclick = closeSettings;
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
settingsSection("Theme", "appearance", buildThemeSection);
settingsSection("Name and icon", "appearance", buildBrandingSection);
settingsSection("Remotes", "account", buildConnectedBackends);
settingsSection("Change password", "account", (body) => {
  body.innerHTML = `
    <form autocomplete="off">
      <div class="field"><label>Current password</label>
        <input type="password" name="current" autocomplete="current-password"></div>
      <div class="field"><label>New password</label>
        <input type="password" name="new" autocomplete="new-password"></div>
      <div class="field"><label>Confirm new password</label>
        <input type="password" name="confirm" autocomplete="new-password"></div>
      <div class="row"><span class="hint"></span>
        <button type="submit" class="primary">Change password</button></div>
      <p class="msg"></p>
    </form>`;
  const form = body.querySelector("form")!,
    msg = body.querySelector<HTMLElement>(".msg")!;
  const btn = body.querySelector<HTMLButtonElement>("button.primary")!;
  const val = (n: string) =>
    (form.elements.namedItem(n) as HTMLInputElement).value;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "msg";
    msg.textContent = "";
    if (val("new").length < 12) {
      msg.className = "msg err";
      msg.textContent = "New password must be at least 12 characters.";
      return;
    }
    if (val("new") !== val("confirm")) {
      msg.className = "msg err";
      msg.textContent = "New passwords don't match.";
      return;
    }
    btn.disabled = true;
    try {
      const r = await homeJpost("/api/password", {
        current: val("current"),
        new: val("new"),
      });
      if (r.ok) {
        clearSkillsCache();
        form.reset();
        msg.className = "msg ok";
        msg.textContent = "Password changed. Other sessions are signed out.";
      } else {
        const detail = await errDetail(r, "Couldn't change the password.");
        msg.className = "msg err";
        msg.textContent = detail;
      }
    } catch {
      msg.className = "msg err";
      msg.textContent = "Network error. Try again.";
    } finally {
      btn.disabled = false;
    }
  });
});

settingsSection("Claude auth", "auth", (body) => {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="row"><span class="authbtns">
        <button type="button" class="primary sub">Subscription</button>
        <button type="button" class="secondary apikey">API key</button>
      </span>
      <button type="button" class="ghost signout" hidden>Log out</button></div>
    <div class="oauth" hidden>
      <p class="hint">Approve access in the Claude tab. Your browser then tries to
        open a <b>localhost</b> page that won't load — that's expected. Copy the
        full URL from its address bar and paste it below.</p>
      <p><a class="link" target="_blank" rel="noopener">Open Claude to authorize →</a></p>
      <div class="field"><label>Paste the redirect URL (or code)</label>
        <input type="text" class="code"
          placeholder="http://localhost:53692/callback?code=…" autocomplete="off"></div>
      <div class="row"><span class="hint"></span>
        <button type="button" class="primary complete">Finish login</button></div>
    </div>
    <div class="localfb" hidden>
      <p class="hint">This server shares an IP that Claude is rate-limiting, so it
        can't finish the exchange. Run one of these on your own machine — your
        network isn't limited — then paste what it prints below.</p>
      <div class="row"><span class="hint">curl</span>
        <button type="button" class="secondary copycmd">Copy</button></div>
      <pre class="cmd"></pre>
      <div class="field"><label>Paste the command's output</label>
        <textarea class="tokenjson" rows="4" autocomplete="off" spellcheck="false"
          placeholder='{"token_type":"Bearer","access_token":"…","refresh_token":"…"}'></textarea></div>
      <div class="row"><span class="hint"></span>
        <button type="button" class="primary completelocal">Finish login</button></div>
    </div>
    <div class="keypanel" hidden>
      <div class="field"><label>Anthropic API key</label>
        <input type="password" class="key" placeholder="sk-ant-…" autocomplete="off"></div>
      <div class="row"><span class="hint"></span>
        <button type="button" class="primary savekey">Save key</button></div>
    </div>
    <p class="msg"></p>`;
  const q = <T extends HTMLElement = HTMLElement>(s: string): T =>
    body.querySelector<T>(s)!;
  const msg = q(".msg");
  const oauth = q(".oauth"),
    keypanel = q(".keypanel"),
    localfb = q(".localfb");
  const link = q<HTMLAnchorElement>(".link"),
    signout = q<HTMLButtonElement>(".signout");
  const hidePanels = () => {
    oauth.hidden = true;
    keypanel.hidden = true;
    localfb.hidden = true;
  };
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const applyStatus = (s: AuthStatus) => {
    const on = !!(s && s.configured);
    // Invariant: An ambient `claude` CLI login is detected, not stored here —
    // recurse can't log it out, and the buttons override it rather than "switch
    // credentials".
    const ambient = on && s.type === "ambient";
    markAuth(body, on, s?.label);
    signout.hidden = !on || ambient;
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  const refresh = () =>
    api("/api/pi/auth")
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => markAuthError(body));
  refresh();

  q<HTMLButtonElement>(".sub").addEventListener("click", async () => {
    show("", "");
    hidePanels();
    q<HTMLButtonElement>(".sub").disabled = true;
    try {
      const r = await jpost("/api/pi/auth/login-url");
      if (!r.ok) throw new Error();
      link.href = ((await r.json()) as { url: string }).url;
      // Invariant: Stale backend replies must not open sign-in.
      if (!body.isConnected) return;
      oauth.hidden = false;
      window.open(link.href, "_blank", "noopener");
      q(".code").focus();
    } catch {
      show("err", "Couldn't start Claude login. Try again.");
    } finally {
      q<HTMLButtonElement>(".sub").disabled = false;
    }
  });

  q(".apikey").addEventListener("click", () => {
    show("", "");
    hidePanels();
    keypanel.hidden = false;
    q(".key").focus();
  });

  q(".complete").addEventListener("click", async () => {
    const code = q<HTMLInputElement>(".code").value.trim();
    if (!code) {
      show("err", "Paste the redirect URL or code from Claude first.");
      return;
    }
    q<HTMLButtonElement>(".complete").disabled = true;
    try {
      const r = await jpost("/api/pi/auth/code", { code });
      if (r.ok) {
        const j = (await r.json()) as CodeResult;
        if (j && j.fallback === "local") {
          // Invariant: Server-side exchange is IP-rate-limited; finish from the
          // user's IP.
          q(".cmd").textContent = j.command;
          localfb.hidden = false;
          show("", "");
          q(".tokenjson").focus();
        } else {
          applyStatus(j);
          oauth.hidden = true;
          q<HTMLInputElement>(".code").value = "";
          show("ok", "Logged in with your Claude subscription.");
        }
      } else {
        const detail = await errDetail(r, "Login failed.");
        show("err", detail);
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      q<HTMLButtonElement>(".complete").disabled = false;
    }
  });

  const copyFrom = async (sel: string) => {
    try {
      await navigator.clipboard.writeText(q(sel).textContent!);
      show("ok", "Command copied. Run it, then paste the output below.");
    } catch {
      show("err", "Couldn't copy — select the command and copy it manually.");
    }
  };
  q(".copycmd").addEventListener("click", () => copyFrom(".cmd"));

  q(".completelocal").addEventListener("click", async () => {
    const token = q<HTMLTextAreaElement>(".tokenjson").value.trim();
    if (!token) {
      show("err", "Paste the command's output first.");
      return;
    }
    q<HTMLButtonElement>(".completelocal").disabled = true;
    try {
      const r = await jpost("/api/pi/auth/token-json", { token });
      if (r.ok) {
        applyStatus(await r.json());
        localfb.hidden = true;
        oauth.hidden = true;
        q<HTMLInputElement>(".code").value = "";
        q<HTMLTextAreaElement>(".tokenjson").value = "";
        q(".cmd").textContent = "";
        show("ok", "Logged in with your Claude subscription.");
      } else {
        const detail = await errDetail(r, "Login failed.");
        show("err", detail);
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      q<HTMLButtonElement>(".completelocal").disabled = false;
    }
  });

  q(".savekey").addEventListener("click", async () => {
    const key = q<HTMLInputElement>(".key").value.trim();
    if (!key) {
      show("err", "Enter an API key first.");
      return;
    }
    q<HTMLButtonElement>(".savekey").disabled = true;
    try {
      const r = await jpost("/api/pi/auth/api-key", { key });
      if (r.ok) {
        applyStatus(await r.json());
        keypanel.hidden = true;
        q<HTMLInputElement>(".key").value = "";
        show("ok", "API key saved.");
      } else {
        const detail = await errDetail(r, "Couldn't save the API key.");
        show("err", detail);
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      q<HTMLButtonElement>(".savekey").disabled = false;
    }
  });

  signout.addEventListener("click", async () => {
    signout.disabled = true;
    try {
      const r = await jpost("/api/pi/auth/logout");
      if (r.ok) {
        applyStatus(await r.json());
        hidePanels();
        show("", "Logged out.");
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      signout.disabled = false;
    }
  });
});

settingsSection("OpenAI auth", "auth", (body) => {
  const { api, jpost } = settingsClient();
  // Invariant: ChatGPT subscription and API keys are distinct billing routes.
  // A saved choice replaces the other, never silently falls back.
  body.innerHTML = `
    <div class="row"><span class="authbtns">
        <button type="button" class="primary sub">Subscription</button>
        <button type="button" class="secondary apikey">API key</button>
      </span>
      <button type="button" class="ghost signout" hidden>Log out</button></div>
    <div class="oauth" hidden>
      <p class="hint">Approve access in the ChatGPT tab. Your browser then tries to
        open a <b>localhost</b> page that won't load — that's expected. Copy the
        full URL from its address bar and paste it below.</p>
      <p><a class="link" target="_blank" rel="noopener">Open ChatGPT to authorize →</a></p>
      <div class="field"><label>Paste the redirect URL (or code)</label>
        <input type="text" class="code"
          placeholder="http://localhost:1455/auth/callback?code=…" autocomplete="off"></div>
      <div class="row"><span class="hint"></span>
        <button type="button" class="primary complete">Finish login</button></div>
    </div>
    <div class="localfb" hidden>
      <p class="hint">This server shares an IP that ChatGPT is rate-limiting, so it
        can't finish the exchange. Run one of these on your own machine — your
        network isn't limited — then paste what it prints below.</p>
      <div class="row"><span class="hint">curl</span>
        <button type="button" class="secondary copycmd">Copy</button></div>
      <pre class="cmd"></pre>
      <div class="field"><label>Paste the command's output</label>
        <textarea class="tokenjson" rows="4" autocomplete="off" spellcheck="false"
          placeholder='{"access_token":"…","refresh_token":"…","expires_in":…}'></textarea></div>
      <div class="row"><span class="hint"></span>
        <button type="button" class="primary completelocal">Finish login</button></div>
    </div>
    <div class="keypanel" hidden>
      <p class="hint">Uses OpenAI platform API billing, not your ChatGPT subscription.</p>
      <div class="field"><label>OpenAI API key</label>
        <input type="password" class="key" placeholder="sk-…" autocomplete="off"></div>
      <div class="row"><span class="hint"></span>
        <button type="button" class="primary savekey">Save key</button></div>
    </div>
    <p class="msg"></p>`;
  const q = <T extends HTMLElement = HTMLElement>(s: string): T =>
    body.querySelector<T>(s)!;
  const msg = q(".msg");
  const oauth = q(".oauth"),
    localfb = q(".localfb"),
    keypanel = q(".keypanel");
  const link = q<HTMLAnchorElement>(".link"),
    signout = q<HTMLButtonElement>(".signout");
  const hidePanels = () => {
    oauth.hidden = true;
    localfb.hidden = true;
    keypanel.hidden = true;
  };
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const applyStatus = (s: AuthStatus) => {
    const on = !!(s && s.configured);
    markAuth(body, on, s?.label);
    signout.hidden = !on;
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  const refresh = () =>
    api("/api/pi/codex-auth")
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => markAuthError(body));
  refresh();

  q<HTMLButtonElement>(".sub").addEventListener("click", async () => {
    show("", "");
    hidePanels();
    q<HTMLButtonElement>(".sub").disabled = true;
    try {
      const r = await jpost("/api/pi/codex-auth/login-url");
      if (!r.ok) throw new Error();
      link.href = ((await r.json()) as { url: string }).url;
      // Invariant: Stale backend replies must not open sign-in.
      if (!body.isConnected) return;
      oauth.hidden = false;
      window.open(link.href, "_blank", "noopener");
      q(".code").focus();
    } catch {
      show("err", "Couldn't start Codex login. Try again.");
    } finally {
      q<HTMLButtonElement>(".sub").disabled = false;
    }
  });

  q(".apikey").addEventListener("click", () => {
    show("", "");
    hidePanels();
    keypanel.hidden = false;
    q(".key").focus();
  });

  q(".complete").addEventListener("click", async () => {
    const code = q<HTMLInputElement>(".code").value.trim();
    if (!code) {
      show("err", "Paste the redirect URL or code from ChatGPT first.");
      return;
    }
    q<HTMLButtonElement>(".complete").disabled = true;
    try {
      const r = await jpost("/api/pi/codex-auth/code", { code });
      if (r.ok) {
        const j = (await r.json()) as CodeResult;
        if (j && j.fallback === "local") {
          // Invariant: Server-side exchange is IP-rate-limited; finish from the
          // user's IP.
          q(".cmd").textContent = j.command;
          localfb.hidden = false;
          show("", "");
          q(".tokenjson").focus();
        } else {
          applyStatus(j);
          oauth.hidden = true;
          q<HTMLInputElement>(".code").value = "";
          show("ok", "Logged in with your ChatGPT subscription.");
        }
      } else {
        const detail = await errDetail(r, "Login failed.");
        show("err", detail);
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      q<HTMLButtonElement>(".complete").disabled = false;
    }
  });

  const copyFrom = async (sel: string) => {
    try {
      await navigator.clipboard.writeText(q(sel).textContent!);
      show("ok", "Command copied. Run it, then paste the output below.");
    } catch {
      show("err", "Couldn't copy — select the command and copy it manually.");
    }
  };
  q(".copycmd").addEventListener("click", () => copyFrom(".cmd"));

  q(".completelocal").addEventListener("click", async () => {
    const token = q<HTMLTextAreaElement>(".tokenjson").value.trim();
    if (!token) {
      show("err", "Paste the command's output first.");
      return;
    }
    q<HTMLButtonElement>(".completelocal").disabled = true;
    try {
      const r = await jpost("/api/pi/codex-auth/token-json", { token });
      if (r.ok) {
        applyStatus(await r.json());
        localfb.hidden = true;
        oauth.hidden = true;
        q<HTMLInputElement>(".code").value = "";
        q<HTMLTextAreaElement>(".tokenjson").value = "";
        q(".cmd").textContent = "";
        show("ok", "Logged in with your ChatGPT subscription.");
      } else {
        const detail = await errDetail(r, "Login failed.");
        show("err", detail);
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      q<HTMLButtonElement>(".completelocal").disabled = false;
    }
  });

  q(".savekey").addEventListener("click", async () => {
    const key = q<HTMLInputElement>(".key").value.trim();
    if (!key) {
      show("err", "Enter an API key first.");
      return;
    }
    q<HTMLButtonElement>(".savekey").disabled = true;
    try {
      const r = await jpost("/api/pi/codex-auth/api-key", { key });
      if (r.ok) {
        applyStatus(await r.json());
        keypanel.hidden = true;
        q<HTMLInputElement>(".key").value = "";
        show("ok", "OpenAI API key saved.");
      } else {
        const detail = await errDetail(r, "Couldn't save the API key.");
        show("err", detail);
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      q<HTMLButtonElement>(".savekey").disabled = false;
    }
  });

  signout.addEventListener("click", async () => {
    signout.disabled = true;
    try {
      const r = await jpost("/api/pi/codex-auth/logout");
      if (r.ok) {
        applyStatus(await r.json());
        hidePanels();
        show("", "Logged out.");
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      signout.disabled = false;
    }
  });
});

// Muse subscription stays hidden until its login flow is verified end-to-end.
const SHOW_MUSE_SUBSCRIPTION = false;
// One method: a Muse subscription via Meta device sign-in. Sign in shows
// the Meta URL and a code to enter there, then polls until Meta approves
// and mints the subscription key. This is separate billing from the Meta
// pay-as-you-go API key; saving one never touches the other.
function buildMuseSubscriptionSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="row"><span class="authbtns">
        <button type="button" class="primary signin">Sign in</button>
      </span>
      <button type="button" class="ghost signout" hidden>Log out</button></div>
    <div class="device" hidden>
      <p class="hint">Open the Meta page and enter the code below. Then wait —
        this page checks with Meta every few seconds until you approve.</p>
      <p><a class="link" target="_blank" rel="noopener">Open Meta to authorize →</a></p>
      <div class="field"><label>Code to enter on the Meta page</label>
        <div class="row"><code class="usercode"></code>
        <button type="button" class="secondary copycode">Copy code</button></div></div>
      <p class="hint polling">Waiting for approval…</p>
    </div>
    <p class="msg"></p>`;
  const q = <T extends HTMLElement = HTMLElement>(s: string): T =>
    body.querySelector<T>(s)!;
  const msg = q(".msg");
  const device = q(".device");
  const link = q<HTMLAnchorElement>(".link");
  const signin = q<HTMLButtonElement>(".signin");
  const signout = q<HTMLButtonElement>(".signout");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  const stopPolling = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const applyStatus = (s: AuthStatus) => {
    const on = !!(s && s.configured);
    markAuth(body, on, s?.label);
    signout.hidden = !on;
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  const refresh = () =>
    api("/api/pi/muse-auth")
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => markAuthError(body));
  refresh();

  const poll = async () => {
    timer = null;
    if (!body.isConnected) return;
    if (deadline && Date.now() > deadline) {
      device.hidden = true;
      signin.disabled = false;
      show("err", "The code expired. Start over with Sign in.");
      return;
    }
    try {
      const r = await jpost("/api/pi/muse-auth/poll");
      if (!r.ok) {
        const detail = await errDetail(r, "Sign-in failed.");
        device.hidden = true;
        signin.disabled = false;
        show("err", detail);
        return;
      }
      const j = (await r.json()) as AuthStatus & {
        status?: string;
        interval?: number;
        expires_in?: number;
      };
      if (j && j.configured) {
        stopPolling();
        device.hidden = true;
        signin.disabled = false;
        q(".usercode").textContent = "";
        applyStatus(j);
        show("ok", "Signed in with your Muse subscription.");
        return;
      }
      const wait = Math.min(Math.max(j.interval ?? 5, 1), 30);
      q(".polling").textContent = "Waiting for approval…";
      timer = setTimeout(poll, wait * 1000);
    } catch {
      device.hidden = true;
      signin.disabled = false;
      show("err", "Network error. Try again.");
    }
  };

  signin.addEventListener("click", async () => {
    show("", "");
    stopPolling();
    signin.disabled = true;
    try {
      const r = await jpost("/api/pi/muse-auth/start");
      if (!r.ok) throw new Error();
      const j = (await r.json()) as {
        url: string;
        user_code: string;
        interval?: number;
        expires_in?: number;
      };
      if (!body.isConnected) return;
      link.href = j.url;
      q(".usercode").textContent = j.user_code;
      device.hidden = false;
      window.open(j.url, "_blank", "noopener");
      deadline = Date.now() + (j.expires_in ?? 600) * 1000;
      const wait = Math.min(Math.max(j.interval ?? 5, 1), 30);
      timer = setTimeout(poll, wait * 1000);
    } catch {
      signin.disabled = false;
      show("err", "Couldn't start Muse sign-in. Try again.");
    }
  });

  q(".copycode").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(q(".usercode").textContent!);
      show("ok", "Code copied. Enter it on the Meta page.");
    } catch {
      show("err", "Couldn't copy — select the code and copy it manually.");
    }
  });

  signout.addEventListener("click", async () => {
    signout.disabled = true;
    try {
      const r = await jpost("/api/pi/muse-auth/logout");
      if (r.ok) {
        stopPolling();
        applyStatus(await r.json());
        device.hidden = true;
        signin.disabled = false;
        q(".usercode").textContent = "";
        show("", "Logged out.");
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      signout.disabled = false;
    }
  });
}
if (SHOW_MUSE_SUBSCRIPTION)
  settingsSection("Muse subscription", "auth", buildMuseSubscriptionSection);

settingsSection("OpenRouter auth", "auth", (body) => {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="field"><label>OpenRouter API key</label><input type="password"
      class="key" placeholder="sk-or-…" autocomplete="off"></div>
    <div class="row"><span class="hint"></span>
      <span class="authbtns"><button type="button" class="ghost signout" hidden>Log out</button>
      <button type="button" class="primary savekey">Save key</button></span></div>
    <p class="msg"></p>`;
  const q = <T extends HTMLElement = HTMLElement>(s: string): T =>
    body.querySelector<T>(s)!;
  const msg = q(".msg"),
    key = q<HTMLInputElement>(".key");
  const save = q<HTMLButtonElement>(".savekey"),
    signout = q<HTMLButtonElement>(".signout");
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const applyStatus = (s: AuthStatus) => {
    const on = !!(s && s.configured);
    markAuth(body, on, s?.label);
    signout.hidden = !on;
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  api("/api/pi/openrouter-auth")
    .then((r) => r.json())
    .then(applyStatus)
    .catch(() => markAuthError(body));
  save.addEventListener("click", async () => {
    const value = key.value.trim();
    if (!value) {
      show("err", "Enter an API key first.");
      return;
    }
    save.disabled = true;
    try {
      const r = await jpost("/api/pi/openrouter-auth/api-key", { key: value });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save the API key."));
        return;
      }
      applyStatus(await r.json());
      key.value = "";
      show("ok", "OpenRouter API key saved.");
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      save.disabled = false;
    }
  });
  signout.addEventListener("click", async () => {
    signout.disabled = true;
    try {
      const r = await jpost("/api/pi/openrouter-auth/logout");
      if (r.ok) {
        applyStatus(await r.json());
        show("", "Logged out.");
      }
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      signout.disabled = false;
    }
  });
});

settingsSection("Custom model keys", "auth", (body) => {
  const { api, jpost } = settingsClient();
  // Invariant: Keys go only to credential-store endpoints, never config.
  body.innerHTML = `
    <div class="customkeys"></div>
    <p class="msg"></p>`;
  const list = body.querySelector<HTMLElement>(".customkeys")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  type Status = Record<string, { configured?: boolean }>;
  const render = (state: Status) => {
    list.textContent = "";
    const names = Object.keys(state);
    if (!names.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent =
        "No custom model endpoints are configured on this instance.";
      list.appendChild(p);
      return;
    }
    for (const name of names) {
      const on = !!state[name]?.configured;
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = name;
      label.title = on ? "Key saved" : "No key saved";
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = on
        ? "Key saved — paste a new one to replace"
        : "Paste API key";
      input.setAttribute("aria-label", `API key for ${name}`);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary";
      save.textContent = "Save key";
      const signout = document.createElement("button");
      signout.type = "button";
      signout.className = "ghost";
      signout.textContent = "Log out";
      signout.hidden = !on;
      save.onclick = async () => {
        const key = input.value.trim();
        if (!key) {
          show("err", `Enter an API key for ${name} first.`);
          return;
        }
        save.disabled = true;
        try {
          const r = await jpost(
            `/api/pi/custom-provider-auth/${encodeURIComponent(name)}/api-key`,
            { key },
          );
          if (!r.ok) {
            show("err", await errDetail(r, "Couldn't save the API key."));
            return;
          }
          Object.assign(state, (await r.json()) as Status);
          input.value = "";
          render(state);
          show("ok", `API key saved for ${name}.`);
          window.dispatchEvent(new Event("recurse-auth-changed"));
        } catch {
          show("err", "Network error. Try again.");
        } finally {
          save.disabled = false;
        }
      };
      signout.onclick = async () => {
        signout.disabled = true;
        try {
          const r = await jpost(
            `/api/pi/custom-provider-auth/${encodeURIComponent(name)}/logout`,
          );
          if (!r.ok) {
            show("err", await errDetail(r, "Couldn't log out."));
            return;
          }
          Object.assign(state, (await r.json()) as Status);
          render(state);
          show(
            "",
            state[name]?.configured
              ? `${name} still has a key from the server environment.`
              : `Logged out of ${name}.`,
          );
          window.dispatchEvent(new Event("recurse-auth-changed"));
        } catch {
          show("err", "Network error. Try again.");
        } finally {
          signout.disabled = false;
        }
      };
      row.append(label, input, save, signout);
      list.appendChild(row);
    }
  };
  api("/api/pi/custom-provider-auth")
    .then((r) => r.json())
    .then(render)
    .catch(() => show("err", "Couldn't load custom model keys."));
});

settingsSection("Deleted agents' history", "account", (body) => {
  const { api, jpost } = settingsClient();
  body.innerHTML = `<form>
    <label>Keep deleted agents' history for
      <input id="deleted-agent-history" type="number" aria-label="Keep deleted agents' history (days)"
        min="1" max="36500" step="1" required> days</label>
    <div class="row"><button type="submit" class="primary">Save</button></div>
    <p class="msg"></p></form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector("input")!;
  const button = body.querySelector("button")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  api("/api/settings/deleted-agent-history")
    .then((r) => r.json())
    .then((state: { days: number }) => {
      input.value = String(state.days);
    })
    .catch(() => {
      msg.textContent = "Couldn't load deleted agents' history settings.";
    });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      const r = await jpost("/api/settings/deleted-agent-history", {
        days: input.valueAsNumber,
      });
      if (!r.ok) {
        msg.textContent = await errDetail(r, "Couldn't save.");
        return;
      }
      input.value = String(((await r.json()) as { days: number }).days);
      msg.textContent = "Saved. Applies during the next cleanup.";
    } catch {
      msg.textContent = "Network error. Try again.";
    } finally {
      button.disabled = false;
    }
  });
});

settingsSection("Maximum context window", "models", (body) => {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <form>
      <div class="context-window-controls">
        <input type="range" aria-label="Maximum context window slider (tokens)"
          min="64000" max="1000000" step="1000" value="400000">
        <input id="maximum-context-window" type="number" name="maximum"
          aria-label="Maximum context window (tokens)"
          min="64000" max="1000000" step="1" required></div>
      <div class="row"><button type="submit" class="primary">Save</button></div>
      <p class="msg"></p>
    </form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector<HTMLInputElement>('input[type="number"]')!;
  const slider = body.querySelector<HTMLInputElement>('input[type="range"]')!;
  const button = body.querySelector<HTMLButtonElement>("button")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const syncSlider = () => {
    if (!input.validity.valid) return;
    slider.step = input.valueAsNumber % 1000 === 0 ? "1000" : "1";
    slider.value = input.value;
  };
  input.addEventListener("input", syncSlider);
  slider.addEventListener("input", () => {
    input.value = slider.value;
    syncSlider();
  });
  api("/api/settings/maximum-context-window")
    .then((r) => r.json())
    .then((state: { maximum_context_window: number }) => {
      input.value = String(state.maximum_context_window);
      syncSlider();
    })
    .catch(() => show("err", "Couldn't load the maximum context window."));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    show("", "");
    try {
      const r = await jpost("/api/settings/maximum-context-window", {
        maximum_context_window: Number(input.value),
      });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save."));
        return;
      }
      const state = (await r.json()) as { maximum_context_window: number };
      input.value = String(state.maximum_context_window);
      syncSlider();
      show("ok", "Saved. Applies when an agent process next starts.");
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
});

interface LadderModelOption {
  id: string;
  label: string;
}
interface LadderState {
  default_level: number;
  levels: Record<string, { model: string; reasoning: string }>;
  reachability: Record<
    string,
    { reachable: boolean; model: string; reasoning: string; reason: string }
  >;
  models: LadderModelOption[];
  reasoning: string[];
}
interface ModelListState {
  models: FinderModel[];
  reasoning: string[];
}
interface LadderRow {
  level: number;
  box: ModelBox;
  reasoning: HTMLSelectElement;
  /** The user picked a model or reasoning here since the last load. */
  edited: boolean;
}
settingsSection("Effort ladder", "models", (body) => {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <form>
      <div class="row model-list-update">
        <span class="hint model-list-status" role="status"></span>
        <button type="button" class="secondary model-list-update-button">Update model list</button>
      </div>
      <div class="efforts"></div>
      <div class="row"><button type="submit" class="primary">Save</button></div>
      <p class="msg"></p>
    </form>`;
  const form = body.querySelector("form")!;
  const list = body.querySelector<HTMLElement>(".efforts")!;
  const button = body.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const listStatus = body.querySelector<HTMLElement>(".model-list-status")!;
  const updateButton = body.querySelector<HTMLButtonElement>(
    ".model-list-update-button",
  )!;
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  let defaultLevel = 3;
  let rows: LadderRow[] = [];
  let known = new Map<string, FinderModel>();
  let ladderLabels = new Map<string, string>();
  let allLevels: string[] = [...THINKING_ORDER];
  const nameOf = (id: string) =>
    known.get(id)?.label ?? ladderLabels.get(id) ?? id;
  // Invariant: A value Pi does not offer for this model stays selectable,
  // marked, so an untouched row saves what it already stores.
  const fillReasoning = (
    select: HTMLSelectElement,
    model: string,
    selected: string,
  ) => {
    const choices = reasoningChoices(
      known.get(model)?.reasoning_levels,
      allLevels,
    );
    select.textContent = "";
    for (const level of choices) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      select.append(option);
    }
    if (!choices.includes(selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = `${selected} (not offered for this model)`;
      select.append(option);
    }
    select.value = selected;
  };
  const render = (
    ladder: LadderState,
    index: readonly IndexedModel[],
    unsaved: Map<number, { model: string; reasoning: string }>,
  ) => {
    // Invariant: The rows edit models and reasoning only; the instance default
    // level rides the save untouched so it is never reset as a side effect.
    defaultLevel = ladder.default_level;
    list.textContent = "";
    rows = [];
    for (let level = 1; level <= 5; level++) {
      const entry = ladder.levels[String(level)];
      if (!entry) continue;
      // Invariant: Keep an unsaved edit across a reload after a list update; a
      // row the user did not touch takes the reloaded value.
      const kept = unsaved.get(level);
      const keep =
        kept !== undefined &&
        (known.has(kept.model) || kept.model === entry.model);
      const model = keep ? kept.model : entry.model;
      const info = ladder.reachability[String(level)];
      const row = document.createElement("div");
      row.className = "row effort";
      const name = document.createElement("span");
      name.textContent = `Level ${level}`;
      if (level === 1) {
        const note = document.createElement("span");
        note.className = "effort-note";
        note.textContent =
          "(Used for safety review and conversation names; choose an inexpensive model such as Luna or Haiku.)";
        name.append(note);
      }
      const reasoning = document.createElement("select");
      reasoning.dataset.level = String(level);
      reasoning.setAttribute("aria-label", `Reasoning for level ${level}`);
      const box = createModelBox({
        label: `Model for level ${level}`,
        index,
        value: model,
        nameOf,
        onPick: (picked) => {
          ladderRow.edited = true;
          fillReasoning(
            reasoning,
            picked.id,
            clampReasoning(
              reasoningChoices(picked.reasoning_levels, allLevels),
              reasoning.value,
            ),
          );
        },
      });
      const ladderRow: LadderRow = { level, box, reasoning, edited: keep };
      reasoning.addEventListener("change", () => (ladderRow.edited = true));
      fillReasoning(reasoning, model, keep ? kept.reasoning : entry.reasoning);
      row.append(name, box.element, reasoning);
      if (info && !info.reachable) {
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = info.reason;
        row.append(note);
      }
      list.appendChild(row);
      rows.push(ladderRow);
    }
  };
  // Invariant: Only the newest load renders, so an older reply cannot replace
  // it.
  let loads = 0;
  const loadLadder = async () => {
    const load = ++loads;
    try {
      const [ladderResponse, listResponse] = await Promise.all([
        api("/api/settings/effort-levels"),
        api("/api/settings/model-list").catch(() => null),
      ]);
      const ladder = (await ladderResponse.json()) as LadderState;
      let listed: ModelListState | null = null;
      if (listResponse?.ok)
        listed = (await listResponse.json()) as ModelListState;
      if (load !== loads) return;
      if (!listed)
        show(
          "err",
          "Couldn't load the model list. Only the ladder's own models are offered.",
        );
      ladderLabels = new Map(ladder.models.map((m) => [m.id, m.label]));
      allLevels = listed?.reasoning ?? ladder.reasoning;
      const models: FinderModel[] =
        listed?.models ??
        ladder.models.map((m) => ({
          id: m.id,
          label: m.label,
          route: "",
          context_window: null,
          reasoning_levels: null,
        }));
      known = new Map(models.map((m) => [m.id, m]));
      const unsaved = new Map(
        rows
          .filter((row) => row.edited)
          .map((row) => [
            row.level,
            { model: row.box.value(), reasoning: row.reasoning.value },
          ]),
      );
      const focused = rows.find(
        (row) => row.box.input === document.activeElement,
      )?.level;
      render(ladder, indexModels(models), unsaved);
      rows.find((row) => row.level === focused)?.box.input.focus();
    } catch {
      show("err", "Couldn't load the effort ladder.");
    }
  };
  void loadLadder();
  const showListStatus = (status: ModelListUpdateStatus) => {
    listStatus.textContent = modelListStatusText(status);
    listStatus.classList.toggle("err", Boolean(status.error));
    updateButton.disabled = status.updating;
  };
  const followUpdate = async (status: ModelListUpdateStatus) => {
    showListStatus(status);
    for (let polls = 0; status.updating && polls < 120; polls++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!body.isConnected) return;
      status = await (await api("/api/settings/model-list-update")).json();
      showListStatus(status);
    }
    if (!status.updating) await loadLadder();
  };
  api("/api/settings/model-list-update")
    .then((r) => r.json())
    .then((status: ModelListUpdateStatus) =>
      status.updating ? followUpdate(status) : showListStatus(status),
    )
    .catch(() => (listStatus.textContent = "Couldn't read the model list."));
  updateButton.addEventListener("click", async () => {
    updateButton.disabled = true;
    try {
      const r = await jpost("/api/settings/model-list-update", {});
      if (!r.ok) {
        listStatus.textContent = await errDetail(
          r,
          "Couldn't start the update.",
        );
        updateButton.disabled = false;
        return;
      }
      await followUpdate(await r.json());
    } catch {
      listStatus.textContent = "Network error. Try again.";
      updateButton.disabled = false;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    show("", "");
    const levels: Record<string, { model: string; reasoning: string }> = {};
    for (const row of rows)
      levels[String(row.level)] = {
        model: row.box.value(),
        reasoning: row.reasoning.value,
      };
    try {
      const r = await jpost("/api/settings/effort-levels", {
        levels,
        default_level: defaultLevel,
      });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save."));
        return;
      }
      window.dispatchEvent(new Event("recurse-ladder-changed"));
      show("ok", "Saved. Applies to new turns.");
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
});

// ---- section: MCP servers ----
// Checked before Save so a paste slip shows under the box; the server still
// validates the shape.
function mcpJsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    return "This isn't valid JSON. Check for a missing comma, quote or brace.";
  }
}

settingsSection("MCP servers", "agents", (body) => {
  const { api } = settingsClient();
  body.innerHTML = `
    <form>
      <p class="hint">MCP servers your agents can use.</p>
      <textarea class="tokenjson" rows="10" autocomplete="off"
        spellcheck="false" aria-label="MCP servers JSON"></textarea>
      <p class="msg err json-err" role="alert" hidden></p>
      <div class="row"><span></span>
        <button type="submit" class="primary" disabled>Save</button></div>
      <p class="msg"></p>
    </form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector<HTMLTextAreaElement>("textarea")!;
  const button = body.querySelector<HTMLButtonElement>("button")!;
  const msg = body.querySelector<HTMLElement>(".msg:not(.json-err)")!;
  const jsonErr = body.querySelector<HTMLElement>(".json-err")!;
  body.classList.add("mcp-settings");
  const refreshStatus = buildMcpStatus(body);
  let loaded = false;
  const showJsonErr = (text: string) => {
    jsonErr.textContent = text;
    jsonErr.hidden = !text;
    input.setAttribute("aria-invalid", text ? "true" : "false");
  };
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  api("/api/settings/mcp-servers")
    .then(async (r) => {
      if (r.status === 400) {
        show("err", `${await errDetail(r, "")}. Saving replaces the file.`);
        loaded = true;
        button.disabled = false;
        return;
      }
      if (!r.ok) throw new Error(await errDetail(r, ""));
      input.value = ((await r.json()) as { text: string }).text;
      // Invariant: Save replaces the whole file, so it waits for the stored
      // servers.
      loaded = true;
      button.disabled = false;
    })
    .catch((error: Error) =>
      show("err", error.message || "Couldn't load the MCP servers."),
    );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!loaded) return;
    show("", "");
    const invalid = mcpJsonError(input.value);
    showJsonErr(invalid ?? "");
    if (invalid) return;
    button.disabled = true;
    try {
      const r = await api("/api/settings/mcp-servers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input.value }),
      });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save."));
        return;
      }
      input.value = ((await r.json()) as { text: string }).text;
      show("ok", "Saved. Agents use the new servers from their next turn.");
      refreshStatus();
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      button.disabled = !loaded;
    }
  });
});

settingsSection("Notifications", "account", buildNotificationsSection);
settingsSection("Updates", "account", buildUpdatesSection);
settingsSection("Session", "account", (body) => {
  body.innerHTML = `
    <div class="row"><span class="hint">Sign out of this browser</span>
      <button type="button" class="ghost">Log out</button></div>`;
  body.querySelector("button")!.onclick = async () => {
    clearSkillsCache();
    try {
      await homeJpost("/logout");
    } catch {}
    location.reload();
  };
});
