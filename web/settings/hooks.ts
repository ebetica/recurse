// Settings → Hooks: the operator's hook files and the "Run hooks" switch.
// Code stays collapsed until asked for; an open editor is never overwritten.
import { api, jpost } from "../api.js";
import { settingsDetail } from "./layout.js";

const PATH = "/api/settings/hooks";

type HookFile = {
  name: string;
  source: string;
  events?: string[];
  unsupported?: string[];
  failure?: { at: number; error: string };
};
type HookState = { enabled: boolean; files: HookFile[] };

const NEW_HOOK = `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    // Return { block: true, reason } to stop the call.
  });
}
`;

export function buildHooksSection(body: HTMLElement): void {
  body.innerHTML = `<div class="hooks-settings">
    <div class="group"><label class="item check"><span id="run-hooks-label">Run hooks</span>
      <input type="checkbox" class="switch" role="switch" aria-labelledby="run-hooks-label" disabled>
    </label></div>
    <p class="msg err" role="alert" hidden></p>
    <div class="group hooks-list" aria-label="Hooks"></div>
    <div><button class="secondary" type="button" data-add disabled>Add hook</button></div>
    <form hidden>
      <label for="hook-name">File name</label>
      <input id="hook-name" autocomplete="off" spellcheck="false" placeholder="no-force-push.ts">
      <label for="hook-code">Code</label>
      <textarea id="hook-code" class="tokenjson" rows="14" autocomplete="off" spellcheck="false" wrap="off"></textarea>
      <div class="actions"><button class="secondary" type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Save</button></div>
    </form>
  </div>`;
  const panel = body.querySelector<HTMLElement>(".hooks-settings")!;
  const enabled = panel.querySelector<HTMLInputElement>(".switch")!;
  const error = panel.querySelector<HTMLElement>(".msg.err")!;
  const list = panel.querySelector<HTMLElement>(".hooks-list")!;
  const add = panel.querySelector<HTMLButtonElement>("[data-add]")!;
  const form = panel.querySelector("form")!;
  const name = form.querySelector<HTMLInputElement>("#hook-name")!;
  const code = form.querySelector<HTMLTextAreaElement>("#hook-code")!;
  settingsDetail(body, "Hooks", () => "Manage hooks");
  const say = (text: string) => {
    error.textContent = text;
    error.hidden = !text;
  };
  const request = async (response: Promise<Response>) => {
    const done = await response;
    const body = (await done.json().catch(() => null)) as
      | (HookState & { detail?: string })
      | null;
    if (!done.ok || !body)
      throw new Error(body?.detail || "Couldn't update hooks.");
    render(body);
  };
  const change = (path: string, value: unknown) =>
    request(jpost(`${PATH}${path}`, value)).then(
      () => true,
      (cause: Error) => {
        say(cause.message);
        return false;
      },
    );
  const edit = (file?: HookFile) => {
    form.hidden = false;
    add.hidden = true;
    name.value = file?.name ?? "";
    name.readOnly = !!file;
    code.value = file?.source ?? NEW_HOOK;
    (file ? code : name).focus();
  };
  const close = () => {
    form.hidden = true;
    add.hidden = false;
  };
  const row = (file: HookFile) => {
    const root = document.createElement("div");
    root.className = "mcp-server";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = file.name;
    const detail = document.createElement("div");
    detail.className = "mcp-detail";
    detail.textContent = [
      !file.events
        ? "Events show after its first run"
        : file.events.length
          ? `Runs on ${file.events.join(", ")}`
          : "Runs on no supported event",
      file.unsupported?.length &&
        `Not supported here: ${file.unsupported.join(", ")}`,
      file.failure &&
        `Last failed ${new Date(file.failure.at).toLocaleString()}: ${file.failure.error}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const source = document.createElement("pre");
    source.hidden = true;
    const show = document.createElement("button");
    show.type = "button";
    show.className = "secondary";
    show.textContent = "Show code";
    show.setAttribute("aria-expanded", "false");
    show.onclick = () => {
      source.hidden = !source.hidden;
      source.textContent = source.hidden ? "" : file.source;
      show.textContent = source.hidden ? "Show code" : "Hide code";
      show.setAttribute("aria-expanded", String(!source.hidden));
    };
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = "Edit";
    open.setAttribute("aria-label", `Edit ${file.name}`);
    open.onclick = () => edit(file);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary danger";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${file.name}`);
    remove.onclick = () => {
      if (confirm(`Delete the hook ${file.name}? Its code can't be restored.`))
        void change("/delete", { name: file.name });
    };
    info.append(title, detail);
    root.append(info, show, open, remove, source);
    return root;
  };
  const render = (state: HookState) => {
    say("");
    enabled.checked = state.enabled;
    enabled.disabled = add.disabled = false;
    list.replaceChildren(...state.files.map(row));
    if (!state.files.length) list.textContent = "No hooks yet.";
  };
  enabled.onchange = () => {
    enabled.disabled = true;
    void change("/enabled", { enabled: enabled.checked }).then((done) => {
      if (!done) enabled.checked = !enabled.checked;
      enabled.disabled = false;
    });
  };
  add.onclick = () => edit();
  form.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (await change("/file", { name: name.value, source: code.value }))
      close();
  };
  list.textContent = "Loading…";
  request(api(PATH)).catch((cause: Error) => say(cause.message));
}
