// Settings rebuilds sections on open and target changes (settings/target.ts).
// Label controls; add text only for non-obvious consequences or actionable
// errors. Do not expose implementation names. Each section or list item has at
// most one primary button for its main action.
import { $ } from "./dom.js";
import { jpost as homeJpost } from "./api.js";
import { setSettingsLabel, settingsClient } from "./settings/target.js";
import { backends } from "./backends/backend.js";
import {
  buildClaudeSection,
  buildOpenAISection,
  buildOpenRouterSection,
  buildCustomKeysSection,
  buildMuseSubscriptionSection,
  SHOW_MUSE_SUBSCRIPTION,
} from "./settings/auth.js";
import {
  buildPromptCacheSection,
  buildMaximumContextSection,
  buildLadderSection,
} from "./settings/models.js";
import { clearSkillsCache } from "./skills.js";
import { installFocusTrap, restoreFocus } from "./focus_trap.js";
import { buildThemeSection } from "./settings/theme.js";
import { buildBrandingSection } from "./settings/branding.js";
import { buildSidebarSection } from "./settings/sidebar.js";
import { buildMcpStatus } from "./settings/mcp.js";
import { buildConnectedBackends } from "./settings/backends.js";
import { buildNotificationsSection } from "./settings/notifications.js";
import { buildUpdatesSection, showRelease } from "./settings/updates.js";
import {
  categoryButton,
  categoryPage,
  closeSettingsDetails,
  settingsDetail,
  settingsSectionShell,
  type Category,
} from "./settings/layout.js";

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
const settingsSections: { title: string; cat: Category; build: BuildFn }[] = [];
const settingsSection = (title: string, cat: Category, build: BuildFn) =>
  settingsSections.push({ title, cat, build });
// Login sections show the provider's tile and login state.
const PROVIDERS = new Set(["Claude", "OpenAI", "Muse", "OpenRouter"]);

const settingsOverlay = $("#settings-overlay")!;
const settingsModal = $("#settings-modal")!;
let settingsReturnFocus: HTMLElement | null = null;
installFocusTrap(
  settingsModal,
  () => !settingsModal.querySelector("dialog[open]"),
);
const settingsBackend = $<HTMLSelectElement>("#settings-backend")!;
settingsBackend.onchange = () => renderSettings(settingsBackend.value);
let showCategory: (cat: Category, drill: boolean) => void = () => {};
/** Open Settings; a category opens that page directly, also on phones. */
export function openSettings(cat?: Category) {
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  settingsReturnFocus = active?.closest("#pane-menu") ? $("#pane-fab") : active;
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
  if (!settingsOpen()) pushSettingsEntry(1);
  settingsOverlay.classList.add("on");
  if (cat) showCategory(cat, true);
  if (cat && phoneSettings.matches) pushSettingsEntry(2);
  // Invariant: Focus moves into Settings: the back link when a phone shows a
  // category page, else the chosen (or first) category button.
  const back = settingsModal.querySelector<HTMLElement>(
    ".settings-cat:not([hidden]) .settings-back",
  );
  const nav = $("#settings-nav")!;
  const target = back?.offsetParent
    ? back
    : (nav.querySelector<HTMLElement>("button.on") ??
      nav.querySelector<HTMLElement>("button"));
  if (target) setTimeout(() => target.focus(), 30);
}
const settingsRelease = $("#settings-release")!;
/** Build every section for one Recurse: "" is this one, else a remote label. */
function renderSettings(label: string) {
  closeSettingsDetails();
  setSettingsLabel(label);
  settingsBackend.value = label;
  void showRelease(settingsRelease, label);
  const pane = $("#settings-sections")!;
  const nav = $("#settings-nav")!;
  pane.textContent = "";
  nav.textContent = "";
  let current: Category | null = null;
  const pages: HTMLElement[] = [];
  // Invariant: Phones show the category list until a category is chosen;
  // wide screens always show the sidebar and the chosen page side by side.
  const show = (cat: Category, drill: boolean) => {
    settingsModal.classList.toggle("drilled", drill);
    for (const btn of nav.querySelectorAll("button"))
      btn.classList.toggle("on", btn.dataset.cat === cat);
    if (current === cat) return;
    current = cat;
    for (const page of pages) page.hidden = page.dataset.cat !== cat;
  };
  showCategory = show;
  const back = () => {
    if (settingsDepth() === 2) return history.back();
    settingsModal.classList.remove("drilled");
    nav.querySelector<HTMLElement>(`[data-cat="${current}"]`)?.focus();
  };
  const cats = label
    ? (["auth", "models", "agents"] as const)
    : (["account", "appearance", "auth", "models", "agents"] as const);
  for (const cat of cats) {
    const btn = categoryButton(cat);
    btn.onclick = () => {
      show(cat, true);
      const link = pages
        .find((page) => !page.hidden)
        ?.querySelector<HTMLElement>(".settings-back");
      if (link?.offsetParent) {
        pushSettingsEntry(2);
        link.focus();
      }
    };
    nav.appendChild(btn);
    const page = categoryPage(cat, back);
    for (const s of settingsSections.filter((x) => x.cat === cat)) {
      const { section, body } = settingsSectionShell(
        s.title,
        PROVIDERS.has(s.title),
      );
      page.appendChild(section);
      s.build(body, closeSettings);
    }
    pane.appendChild(page);
    pages.push(page);
  }
  show(cats[0], false);
}
const phoneSettings = matchMedia("(max-width: 700px)");
const settingsDepth = (): number => Number(history.state?.settings) || 0;
let unwinding = false;
function unwind(): void {
  unwinding = true;
  history.go(-settingsDepth());
}
if (settingsDepth()) unwind();
// The entry last seen, to tell Back from Forward at a skipped entry.
let here = { href: location.href, depth: 0 };
const seen = () => (here = { href: location.href, depth: settingsDepth() });
/** The address Settings opened on; only entries there are its steps. */
let settingsHref = "";
function pushSettingsEntry(depth: number): void {
  // Invariant: Back steps page -> list -> closed via same-URL entries marked
  // `settings` (1 list, 2 page); closing drops them. Marked entries reached
  // with Settings closed are skipped in the travel direction, so Back and
  // Forward never stall; another agent opened meanwhile is its own step.
  if (unwinding) return;
  settingsHref = location.href;
  for (let next = settingsDepth() + 1; next <= depth; next++)
    history.pushState({ ...history.state, settings: next }, "");
  seen();
}
window.addEventListener("popstate", () => {
  const from = here;
  seen();
  if (unwinding) {
    unwinding = false;
    const drilled = settingsModal.classList.contains("drilled");
    if (settingsOpen())
      pushSettingsEntry(drilled && phoneSettings.matches ? 2 : 1);
    return;
  }
  if (!settingsOpen()) {
    const depth = settingsDepth();
    if (depth && from.href === location.href && from.depth < depth)
      history.go(1);
    else if (depth) unwind();
    return;
  }
  if (location.href !== settingsHref) return;
  const depth = settingsDepth();
  if (depth === 1 && settingsModal.classList.contains("drilled")) {
    settingsModal.classList.remove("drilled");
    $("#settings-nav button.on")?.focus();
  } else if (depth === 0) closeSettings();
});
export function closeSettings(): boolean {
  if (!settingsOverlay.classList.contains("on")) return false;
  closeSettingsDetails();
  if (settingsDepth() && !unwinding) unwind();
  else seen();
  settingsOverlay.classList.remove("on");
  settingsModal.classList.remove("drilled");
  restoreFocus(settingsReturnFocus);
  settingsReturnFocus = null;
  return true;
}
export function settingsOpen(): boolean {
  return settingsOverlay.classList.contains("on");
}
$("#settings-btn")!.onclick = () => openSettings();
window.addEventListener("recurse:open-settings", (event) =>
  openSettings((event as CustomEvent<Category>).detail),
);
$("#settings-close")!.onclick = closeSettings;
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
settingsSection("Theme", "appearance", buildThemeSection);
settingsSection("Name and icon", "appearance", buildBrandingSection);
settingsSection("Sidebar", "appearance", buildSidebarSection);
settingsSection("Remotes", "account", buildConnectedBackends);
settingsSection("Change password", "account", (body) => {
  body.innerHTML = `
    <form autocomplete="off">
      <div class="group">
        <label class="item field">Current password
          <input type="password" name="current" autocomplete="current-password"></label>
        <label class="item field">New password
          <input type="password" name="new" autocomplete="new-password"></label>
        <label class="item field">Confirm new password
          <input type="password" name="confirm" autocomplete="new-password"></label>
      </div>
      <div class="actions"><p class="msg"></p>
        <button type="submit" class="primary">Change password</button></div>
    </form>`;
  settingsDetail(body, "Change password");
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

settingsSection("Claude", "auth", buildClaudeSection);
settingsSection("OpenAI", "auth", buildOpenAISection);
if (SHOW_MUSE_SUBSCRIPTION)
  settingsSection("Muse", "auth", buildMuseSubscriptionSection);
settingsSection("OpenRouter", "auth", buildOpenRouterSection);
settingsSection("Custom model keys", "auth", buildCustomKeysSection);

settingsSection("Deleted agents' history", "account", (body) => {
  const { api, jpost } = settingsClient();
  body.innerHTML = `<form>
    <div class="group"><label class="item">Keep deleted agents' history
      <span class="control"><input id="deleted-agent-history" type="number"
        aria-label="Keep deleted agents' history (days)" min="1" max="36500"
        step="1" required> days</span></label></div>
    <div class="actions"><p class="msg"></p>
      <button type="submit" class="primary">Save</button></div></form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector("input")!;
  const button = body.querySelector("button")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const detail = settingsDetail(body, "Deleted agents' history", () =>
    input.value ? `${input.value} days` : "Checking…",
  );
  api("/api/settings/deleted-agent-history")
    .then((r) => r.json())
    .then((state: { days: number }) => {
      input.value = String(state.days);
      detail.refresh();
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
      detail.refresh();
      msg.textContent = "Saved. Applies during the next cleanup.";
    } catch {
      msg.textContent = "Network error. Try again.";
    } finally {
      button.disabled = false;
    }
  });
});

settingsSection("Prompt cache", "models", buildPromptCacheSection);
settingsSection("Maximum context window", "models", buildMaximumContextSection);
settingsSection("Effort ladder", "models", buildLadderSection);

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
      <textarea class="tokenjson" rows="10" autocomplete="off"
        spellcheck="false" aria-label="MCP servers JSON"></textarea>
      <p class="msg err json-err" role="alert" hidden></p>
      <div class="actions"><p class="msg"></p>
        <button type="submit" class="primary" disabled>Save</button></div>
    </form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector<HTMLTextAreaElement>("textarea")!;
  const button = body.querySelector<HTMLButtonElement>("button")!;
  const msg = body.querySelector<HTMLElement>(".msg:not(.json-err)")!;
  const jsonErr = body.querySelector<HTMLElement>(".json-err")!;
  body.classList.add("mcp-settings");
  const refreshStatus = buildMcpStatus(body);
  settingsDetail(body, "MCP servers", () => "Manage servers");
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
    <div class="group"><button type="button" class="item danger">Log out</button></div>`;
  body.querySelector("button")!.onclick = async () => {
    clearSkillsCache();
    try {
      await homeJpost("/logout");
    } catch {}
    location.reload();
  };
});
