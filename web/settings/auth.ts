// Authentication settings own provider sign-in and credential-store requests.
// Provider actions and usage open in a sub-page on desktop, a sheet on phones.
import { copyText } from "../tool_details.js";
import { settingsClient } from "./target.js";
import { settingsDetail, settingsRow } from "./layout.js";
import { showUsageLimits, type UsageLimits } from "./usage-limits.js";
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
    body.querySelector(":scope > .settings-row")?.prepend(tile);
  }
  body.classList.add("auth-detail");
  body.dataset.themeProtected = "provider-sign-in";
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

export function buildClaudeSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  const prefix = "/api/pi/auth";
  body.innerHTML = `<div class="row auth-actions"></div>
    <div class="keypanel" hidden>
      <label class="field">Anthropic API key
        <input type="password" class="key" placeholder="sk-ant-…" autocomplete="off"></label>
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
  providerDetail(body, "Claude");
  const applyStatus = (state: AuthStatus) => {
    const on = !!state?.configured;
    markAuth(body, on, state?.label, state?.type);
    showUsageLimits(body, state);
    signout.hidden = !on || state.type === "ambient";
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  const login = subscriptionLogin(body, {
    name: "Claude",
    prefix,
    jpost,
    show,
    applyStatus,
    tokenExample:
      '{"token_type":"Bearer","access_token":"…","refresh_token":"…"}',
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
      show("err", "Couldn't start Claude sign-in. Try again.");
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
      show("ok", "API key saved.");
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

interface OpenAIStatus {
  subscription: "signed_in" | "imported" | "detected" | null;
  api_key: "saved" | "environment" | null;
  usage_limits?: UsageLimits;
}

export function buildOpenAISection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  const prefix = "/api/pi/codex-auth";
  body.innerHTML = `
    <section class="openai-subscription">
      <h3>ChatGPT subscription</h3>
      <p class="hint credential-status" role="status">Checking…</p>
      <div class="row credential-actions">
        <button type="button" class="secondary signin" disabled>Sign in</button>
        <button type="button" class="ghost remove-sub" hidden>Remove subscription</button>
      </div>
      <p class="msg" role="status"></p>
    </section>
    <section class="openai-api-key">
      <h3>API key</h3>
      <p class="hint credential-status" role="status">Checking…</p>
      <div class="row credential-actions">
        <button type="button" class="secondary editkey" disabled>Add API key</button>
        <button type="button" class="ghost remove-key" hidden>Remove API key</button>
      </div>
      <div class="keypanel" hidden>
        <p class="hint">Uses OpenAI API billing, not your ChatGPT subscription.</p>
        <label class="field">OpenAI API key
          <input type="password" class="key" placeholder="sk-…" autocomplete="off"></label>
        <div class="actions"><button type="button" class="primary savekey">Save key</button></div>
      </div>
      <p class="msg" role="status"></p>
    </section>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    body.querySelector<T>(selector)!;
  const sub = q(".openai-subscription");
  const keyPanel = q(".keypanel");
  const input = q<HTMLInputElement>(".key");
  const signin = q<HTMLButtonElement>(".signin");
  const edit = q<HTMLButtonElement>(".editkey");
  const removeSub = q<HTMLButtonElement>(".remove-sub");
  const removeKey = q<HTMLButtonElement>(".remove-key");
  const save = q<HTMLButtonElement>(".savekey");
  const message = (msg: HTMLElement) => (cls: string, text: string) => {
    msg.className = `msg ${cls}`;
    msg.textContent = text;
  };
  const showSub = message(q(".openai-subscription > .msg"));
  const showKey = message(q(".openai-api-key > .msg"));
  providerDetail(body, "OpenAI");
  const status = statuses.get(body)!;
  const applyStatus = ({
    subscription,
    api_key: key,
    usage_limits,
  }: OpenAIStatus) => {
    q(".openai-subscription .credential-status").textContent =
      subscription === "signed_in"
        ? "Signed in"
        : subscription
          ? "Signed in through Codex"
          : "Not signed in";
    q(".openai-api-key .credential-status").textContent =
      key === "saved" ? "Saved" : key ? "Provided by the server" : "Not saved";
    removeSub.hidden = !subscription || subscription === "detected";
    removeKey.hidden = key !== "saved";
    signin.textContent = subscription ? "Sign in again" : "Sign in";
    edit.textContent = key === "saved" ? "Replace API key" : "Add API key";
    status.text =
      subscription && key
        ? "Subscription + API key"
        : subscription
          ? "Subscription · signed in"
          : key
            ? "API key · available"
            : "Not signed in";
    status.refresh();
    showUsageLimits(sub, { configured: !!subscription, usage_limits });
    window.dispatchEvent(new Event("recurse-auth-changed"));
  };
  const setBusy = (busy: boolean) => {
    for (const button of [signin, edit, removeSub, removeKey, save])
      button.disabled = busy;
  };
  const login = subscriptionLogin(sub, {
    name: "ChatGPT",
    prefix,
    jpost,
    applyStatus,
    show: showSub,
    setBusy,
    tokenExample: '{"access_token":"…","refresh_token":"…","expires_in":…}',
  });
  api(prefix)
    .then((r) => {
      if (!r.ok) throw new Error();
      return r.json();
    })
    .then(applyStatus)
    .catch(() => {
      markAuthError(body);
      for (const state of body.querySelectorAll(".credential-status"))
        state.textContent = "Couldn't check";
    })
    .finally(() => setBusy(false));

  signin.onclick = async () => {
    showSub("", "");
    keyPanel.hidden = true;
    setBusy(true);
    try {
      await login.start();
    } catch {
      showSub("err", "Couldn't start ChatGPT sign-in. Try again.");
    } finally {
      setBusy(false);
    }
  };
  edit.onclick = () => {
    login.hide();
    showKey("", "");
    keyPanel.hidden = false;
    input.focus();
  };
  const change = async (
    path: string,
    data: object | undefined,
    fallback: string,
    show: ReturnType<typeof message>,
    done: () => void,
  ) => {
    setBusy(true);
    sub.inert = true;
    show("", "");
    try {
      const response = await jpost(`${prefix}/${path}`, data);
      if (!response.ok) return show("err", await errDetail(response, fallback));
      applyStatus(await response.json());
    } catch {
      return show("err", "Network error. Try again.");
    } finally {
      sub.inert = false;
      setBusy(false);
    }
    done();
  };
  const closeKeyPanel = () => {
    input.value = "";
    keyPanel.hidden = true;
    edit.focus();
  };
  save.onclick = () => {
    const key = input.value.trim();
    if (!key) return showKey("err", "Enter an API key first.");
    void change(
      "api-key",
      { key },
      "Couldn't save the API key.",
      showKey,
      closeKeyPanel,
    );
  };
  removeKey.onclick = () =>
    void change(
      "api-key/remove",
      undefined,
      "Couldn't remove the API key.",
      showKey,
      closeKeyPanel,
    );
  removeSub.onclick = () =>
    void change(
      "logout",
      undefined,
      "Couldn't remove the subscription sign-in.",
      showSub,
      () => {
        login.hide();
        signin.focus();
      },
    );
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
/** Custom endpoint keys; the section stays hidden while none is configured. */
export function buildCustomKeysSection(body: HTMLElement): void {
  body.dataset.themeProtected = "provider-sign-in";
  const { api, jpost } = settingsClient();
  body.innerHTML =
    '<div class="customkeys group" aria-busy="true"></div><p class="msg"></p>';
  const list = body.querySelector<HTMLElement>(".customkeys")!;
  const section = body.parentElement!;
  section.hidden = true;
  type Status = Record<string, { configured?: boolean }>;
  const render = (state: Status) => {
    const refreshers: (() => void)[] = [];
    list.replaceChildren();
    const names = Object.keys(state);
    section.hidden = !names.length;
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
    list.setAttribute("aria-busy", "false");
  };
  api("/api/pi/custom-provider-auth")
    .then((r) => {
      if (!r.ok) throw new Error("Couldn't load custom model keys.");
      return r.json();
    })
    .then(render)
    .catch(() => {
      section.hidden = false;
      body.querySelector(".msg")!.textContent =
        "Couldn't load custom model keys.";
      list.setAttribute("aria-busy", "false");
    });
}
