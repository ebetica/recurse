// Authentication settings own provider sign-in and credential-store requests.
// Provider actions and usage stay inline on desktop, in sheets on phones.
import { copyText } from "../tool_details.js";
import { settingsClient } from "./target.js";
import { settingsDetail, settingsRow } from "./layout.js";
import { showUsageLimits } from "./usage-limits.js";
import { subscriptionLogin } from "./subscription-login.js";

interface AuthStatus {
  configured?: boolean;
  label?: string;
  type?: string;
}
async function errDetail(r: Response, fallback: string): Promise<string> {
  try {
    return ((await r.json()) as { detail?: string }).detail || fallback;
  } catch {
    return fallback;
  }
}
const statuses = new WeakMap<HTMLElement, { text: string; refresh(): void }>();
function providerDetail(body: HTMLElement, name: string): void {
  const section = body.closest(".settings-section")!;
  const state = { text: "Checking…", refresh: () => {} };
  const detail = settingsDetail(body, name, () => state.text);
  state.refresh = detail.refresh;
  statuses.set(body, state);
  const tile = section.querySelector(".provider-tile")?.cloneNode(true);
  if (tile instanceof HTMLElement) {
    tile.setAttribute("aria-hidden", "true");
    for (const row of body.querySelectorAll(
      ":scope > :is(.settings-row, .settings-detail-summary)",
    ))
      row.prepend(tile.cloneNode(true));
  }
  body.classList.add("auth-detail");
}
function markAuth(
  body: HTMLElement,
  on: boolean,
  label?: string,
  type?: string,
): void {
  const state = statuses.get(body);
  if (!state) return;
  state.text = !on
    ? "Not signed in"
    : type === "ambient"
      ? "Signed in"
      : `${type === "api_key" ? "API key" : "Subscription"} · signed in`;
  body.title = label ?? "";
  state.refresh();
}
function markAuthError(body: HTMLElement): void {
  const state = statuses.get(body);
  if (!state) return;
  state.text = "Couldn't check";
  state.refresh();
}

/** Credentials replace each other; billing routes never fall back. */
function buildSubscriptionProvider(
  body: HTMLElement,
  options: {
    title: string;
    name: string;
    prefix: string;
    keyLabel: string;
    placeholder: string;
    tokenExample: string;
    billingHint?: string;
  },
): void {
  const { api, jpost } = settingsClient();
  const { title, name, prefix } = options;
  body.innerHTML = `<div class="row auth-actions"></div>
    <div class="keypanel" hidden>
      ${options.billingHint ? `<p class="hint">${options.billingHint}</p>` : ""}
      <label class="field">${options.keyLabel}
        <input type="password" class="key" placeholder="${options.placeholder}" autocomplete="off"></label>
      <div class="actions"><button type="button" class="primary savekey">Save key</button></div>
    </div><p class="msg"></p>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    body.querySelector<T>(selector)!;
  const actions = q(".auth-actions");
  const sub = settingsRow("Subscription", "", () => void start());
  sub.classList.add("sub");
  const apikey = settingsRow("API key", "", () => {
    show("", "");
    hidePanels();
    keypanel.hidden = false;
    q(".key").focus();
  });
  apikey.classList.add("apikey");
  const signout = settingsRow("Log out", "", () => void logout());
  signout.classList.add("signout", "danger");
  signout.hidden = true;
  actions.append(sub, apikey, signout);
  const msg = q(".msg");
  const keypanel = q(".keypanel");
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  providerDetail(body, title);
  const applyStatus = (state: AuthStatus) => {
    const on = !!state?.configured;
    markAuth(body, on, state?.label, state?.type);
    showUsageLimits(body, state);
    signout.hidden = !on || (title === "Claude" && state.type === "ambient");
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  const login = subscriptionLogin(body, {
    name,
    prefix,
    jpost,
    show,
    applyStatus,
    tokenExample: options.tokenExample,
  });
  const hidePanels = () => {
    login.hide();
    keypanel.hidden = true;
  };
  api(prefix)
    .then((r) => r.json())
    .then(applyStatus)
    .catch(() => markAuthError(body));
  async function start() {
    show("", "");
    hidePanels();
    sub.disabled = true;
    try {
      await login.start();
    } catch {
      show("err", `Couldn't start ${name} sign-in. Try again.`);
    } finally {
      sub.disabled = false;
    }
  }
  q(".savekey").onclick = async () => {
    const key = q<HTMLInputElement>(".key").value.trim();
    if (!key) {
      show("err", "Enter an API key first.");
      return;
    }
    const save = q<HTMLButtonElement>(".savekey");
    save.disabled = true;
    try {
      const r = await jpost(`${prefix}/api-key`, { key });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save the API key."));
        return;
      }
      applyStatus(await r.json());
      keypanel.hidden = true;
      q<HTMLInputElement>(".key").value = "";
      show(
        "ok",
        title === "OpenAI" ? "OpenAI API key saved." : "API key saved.",
      );
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      save.disabled = false;
    }
  };
  async function logout() {
    signout.disabled = true;
    try {
      const r = await jpost(`${prefix}/logout`);
      if (r.ok) {
        applyStatus(await r.json());
        hidePanels();
        show("", "Logged out.");
      } else show("err", await errDetail(r, "Couldn't log out."));
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      signout.disabled = false;
    }
  }
}

export function buildClaudeSection(body: HTMLElement): void {
  buildSubscriptionProvider(body, {
    title: "Claude",
    name: "Claude",
    prefix: "/api/pi/auth",
    keyLabel: "Anthropic API key",
    placeholder: "sk-ant-…",
    tokenExample:
      '{"token_type":"Bearer","access_token":"…","refresh_token":"…"}',
  });
}
export function buildOpenAISection(body: HTMLElement): void {
  buildSubscriptionProvider(body, {
    title: "OpenAI",
    name: "ChatGPT",
    prefix: "/api/pi/codex-auth",
    keyLabel: "OpenAI API key",
    placeholder: "sk-…",
    tokenExample: '{"access_token":"…","refresh_token":"…","expires_in":…}',
    billingHint:
      "Uses OpenAI platform API billing, not your ChatGPT subscription.",
  });
}

// Muse subscription stays hidden until its login flow is verified end-to-end.
export const SHOW_MUSE_SUBSCRIPTION = false;
// One method: a Muse subscription via Meta device sign-in. Sign in shows
// the Meta URL and a code to enter there, then polls until Meta approves
// and mints the subscription key. This is separate billing from the Meta
// pay-as-you-go API key; saving one never touches the other.
export function buildMuseSubscriptionSection(body: HTMLElement): void {
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
  providerDetail(body, "Muse");
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
    if (await copyText(q(".usercode").textContent!))
      show("ok", "Code copied. Enter it on the Meta page.");
    else show("err", "Couldn't copy — select the code and copy it manually.");
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
export function buildOpenRouterSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="row auth-actions"><button type="button" class="settings-row apikey">API key</button>
      <button type="button" class="settings-row danger signout" hidden>Log out</button></div>
    <div class="keypanel" hidden><label class="field">OpenRouter API key
      <input type="password" class="key" aria-label="OpenRouter API key"
        placeholder="sk-or-…" autocomplete="off"></label>
      <div class="actions"><button type="button" class="primary savekey">Save key</button></div></div>
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
  providerDetail(body, "OpenRouter");
  q(".apikey").onclick = () => {
    q(".keypanel").hidden = false;
    key.focus();
  };
  const applyStatus = (s: AuthStatus) => {
    const on = !!(s && s.configured);
    markAuth(body, on, s?.label, "api_key");
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
      q(".keypanel").hidden = true;
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
}
export function buildCustomKeysSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = '<div class="customkeys group"></div><p class="msg"></p>';
  const list = body.querySelector<HTMLElement>(".customkeys")!;
  type Status = Record<string, { configured?: boolean }>;
  const render = (state: Status) => {
    const refreshers: (() => void)[] = [];
    list.replaceChildren();
    const names = Object.keys(state);
    if (!names.length) {
      list.innerHTML =
        '<p class="hint">No custom model endpoints are configured on this instance.</p>';
      return;
    }
    for (const name of names) {
      const editor = document.createElement("div");
      editor.innerHTML = `<label class="field">API key
        <input type="password" autocomplete="off"></label>
        <div class="actions"><button type="button" class="primary">Save key</button></div>
        <p class="msg"></p>`;
      const input = editor.querySelector("input")!;
      input.setAttribute("aria-label", `API key for ${name}`);
      const save = editor.querySelector("button")!;
      const msg = editor.querySelector<HTMLElement>(".msg")!;
      const show = (cls: string, text: string) => {
        msg.className = "msg " + cls;
        msg.textContent = text;
      };
      const signout = settingsRow("Log out", "", () => void logout());
      signout.classList.add("danger");
      editor.append(signout);
      list.append(editor);
      const detail = settingsDetail(editor, name, () =>
        state[name]?.configured ? "Key saved" : "No key saved",
      );
      const refresh = () => {
        const on = !!state[name]?.configured;
        input.placeholder = on
          ? "Key saved — paste a new one to replace"
          : "Paste API key";
        signout.hidden = !on;
        detail.refresh();
      };
      refreshers.push(refresh);
      refresh();
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
          Object.assign(state, await r.json());
          input.value = "";
          for (const refresh of refreshers) refresh();
          show("ok", `API key saved for ${name}.`);
          window.dispatchEvent(new Event("recurse-auth-changed"));
        } catch {
          show("err", "Network error. Try again.");
        } finally {
          save.disabled = false;
        }
      };
      async function logout() {
        signout.disabled = true;
        try {
          const r = await jpost(
            `/api/pi/custom-provider-auth/${encodeURIComponent(name)}/logout`,
          );
          if (!r.ok) {
            show("err", await errDetail(r, "Couldn't log out."));
            return;
          }
          Object.assign(state, await r.json());
          for (const refresh of refreshers) refresh();
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
      }
    }
  };
  api("/api/pi/custom-provider-auth")
    .then((r) => r.json())
    .then(render)
    .catch(() => {
      body.querySelector(".msg")!.textContent =
        "Couldn't load custom model keys.";
    });
}
