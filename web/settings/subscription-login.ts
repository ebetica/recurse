// Claude and ChatGPT subscription sign-in with the MCP paste-back form; the
// server keeps the PKCE verifier and exchanges the pasted address or code.
// Invariant: A rate-limited exchange returns {fallback: "local", command}: the
// user runs it on their own computer and pastes the token JSON it prints.
import { copyText } from "../tool_details.js";
import { pasteSignInForm } from "./paste-sign-in.js";

interface Options<Status> {
  /** Provider name shown to the user: "Claude" or "ChatGPT". */
  name: string;
  /** Route prefix: /api/pi/auth or /api/pi/codex-auth. */
  prefix: string;
  jpost: (path: string, body?: unknown) => Promise<Response>;
  show: (cls: string, text: string) => void;
  applyStatus: (status: Status) => void;
  /** Example token JSON for the rate-limit fallback's field. */
  tokenExample: string;
}

async function detail(response: Response, fallback: string): Promise<string> {
  try {
    return ((await response.json()) as { detail?: string }).detail || fallback;
  } catch {
    return fallback;
  }
}

/** Add the sign-in panels; `start` begins a sign-in and `hide` ends it. */
export function subscriptionLogin<Status>(
  body: HTMLElement,
  options: Options<Status>,
): { start: () => Promise<void>; hide: () => void } {
  const { name, prefix, jpost, show, applyStatus } = options;
  const done = `Logged in with your ${name} subscription.`;
  const oauth = document.createElement("div");
  oauth.className = "oauth";
  oauth.hidden = true;
  const local = document.createElement("div");
  local.className = "localfb";
  local.hidden = true;
  local.innerHTML = `
    <p class="hint">${name} is rate-limiting this server's network, so it can't
      finish signing in. Run this command on your own computer, then paste what
      it prints below.</p>
    <pre class="cmd"></pre>
    <div class="row"><button type="button" class="secondary copycmd">Copy command</button></div>
    <textarea class="tokenjson" rows="4" autocomplete="off" spellcheck="false"
      aria-label="Command output" placeholder='${options.tokenExample}'></textarea>
    <div class="row"><button type="button" class="secondary completelocal">Finish sign-in</button></div>`;
  body.querySelector(".row")!.after(oauth, local);
  const command = local.querySelector<HTMLElement>(".cmd")!;
  const token = local.querySelector<HTMLTextAreaElement>(".tokenjson")!;
  const finishLocal = local.querySelector<HTMLButtonElement>(".completelocal")!;
  let pending: { url: string; redirectUrl: string; answer: string } | null =
    null;
  let busy = false;

  const hide = () => {
    pending = null;
    oauth.hidden = true;
    oauth.replaceChildren();
    local.hidden = true;
    command.textContent = "";
    token.value = "";
  };
  const signedIn = (status: Status) => {
    applyStatus(status);
    hide();
    show("ok", done);
  };
  const render = () => {
    if (!pending) return;
    const current = pending;
    oauth.replaceChildren(
      pasteSignInForm({
        name,
        url: current.url,
        redirectUrl: current.redirectUrl,
        answer: current.answer,
        onInput: (answer) => (current.answer = answer),
        busy,
        onSubmit: (answer) => void finish(answer),
      }),
    );
    oauth.hidden = false;
  };
  const finish = async (code: string) => {
    show("", "");
    busy = true;
    render();
    try {
      const response = await jpost(`${prefix}/code`, { code });
      if (!response.ok) {
        show("err", await detail(response, "Sign-in failed."));
        return;
      }
      const result = (await response.json()) as Status & {
        fallback?: string;
        command?: string;
      };
      if (result.fallback !== "local") return signedIn(result);
      pending = null;
      oauth.hidden = true;
      oauth.replaceChildren();
      command.textContent = result.command ?? "";
      local.hidden = false;
      token.focus();
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      busy = false;
      render();
    }
  };

  local.querySelector(".copycmd")!.addEventListener("click", async () => {
    if (await copyText(command.textContent ?? ""))
      show("ok", "Command copied. Run it, then paste the output below.");
    else show("err", "Couldn't copy. Select the command and copy it.");
  });
  finishLocal.addEventListener("click", async () => {
    const text = token.value.trim();
    if (!text) {
      show("err", "Paste the command's output first.");
      return;
    }
    finishLocal.disabled = true;
    try {
      const response = await jpost(`${prefix}/token-json`, { token: text });
      if (response.ok) signedIn(await response.json());
      else show("err", await detail(response, "Sign-in failed."));
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      finishLocal.disabled = false;
    }
  });

  const start = async () => {
    hide();
    const response = await jpost(`${prefix}/login-url`);
    if (!response.ok) throw new Error();
    const { url, redirectUrl } = (await response.json()) as {
      url: string;
      redirectUrl: string;
    };
    // Invariant: Stale backend replies must not open sign-in.
    if (!body.isConnected) return;
    pending = { url, redirectUrl, answer: "" };
    render();
    oauth.querySelector<HTMLElement>("a")!.focus();
  };
  return { start, hide };
}
