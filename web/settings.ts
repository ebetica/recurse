// Settings mounts only the open category; closing removes its controls.
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
import { buildThemeSection, cancelThemeCssPreview } from "./settings/theme.js";
import { buildBrandingSection } from "./settings/branding.js";
import { buildSidebarSection } from "./settings/sidebar.js";
import { buildTwoFactorSection } from "./settings/two-factor.js";
import { buildMcpStatus } from "./settings/mcp.js";
import { buildConnectedBackends } from "./settings/backends.js";
import { buildNotificationsSection } from "./settings/notifications.js";
import { hideVersion, showVersion } from "./settings/updates.js";
import {
  CATEGORY_LABELS,
  categoryButton,
  categoryPage,
  closeSettingsDetails,
  relayoutSettingsDetails,
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
type Section = { title: string; cat: Category; build: BuildFn };
const section = (title: string, cat: Category, build: BuildFn): Section => ({
  title,
  cat,
  build,
});
/** Sections for the Recurse chosen in Settings, in page order. */
const remoteSections = [
  section("Claude", "providers", buildClaudeSection),
  section("OpenAI", "providers", buildOpenAISection),
  ...(SHOW_MUSE_SUBSCRIPTION
    ? [section("Muse", "providers", buildMuseSubscriptionSection)]
    : []),
  section("OpenRouter", "providers", buildOpenRouterSection),
  section("Custom model keys", "providers", buildCustomKeysSection),
  section("Effort levels", "models", buildLadderSection),
  section("Context", "models", buildPromptCacheSection),
  section("Maximum context window", "models", buildMaximumContextSection),
  section("MCP servers", "agents", buildMcpSection),
];
/** This Recurse's own sections, before the chosen Recurse's in a category. */
const homeSections = [
  section("Notifications", "agents", buildNotificationsSection),
  section("Deleted agents' history", "agents", buildDeletedHistorySection),
  section("Theme", "appearance", buildThemeSection),
  section("Name and icon", "appearance", buildBrandingSection),
  section("Sidebar", "appearance", buildSidebarSection),
  section("Connected remotes", "remotes", buildConnectedBackends),
  section("Change password", "account", buildPasswordSection),
  section("Two-factor sign-in", "account", buildTwoFactorSection),
  section("Session", "account", buildSessionSection),
];
/** The category last chosen in this browser; Settings reopens on it. */
const LAST_CATEGORY_KEY = "recurse.settingsCategory";
// Login sections show the provider's tile and login state.
const PROVIDERS = new Set(["Claude", "OpenAI", "Muse", "OpenRouter"]);

const settingsOverlay = $("#settings-overlay")!;
const settingsModal = $("#settings-modal")!;
let settingsReturnFocus: HTMLElement | null = null;
installFocusTrap(
  settingsModal,
  () => !settingsModal.querySelector("dialog:modal"),
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
/** Mount one category for this Recurse or a remote, never hidden forms. */
function renderSettings(label: string) {
  cancelThemeCssPreview();
  closeSettingsDetails();
  setSettingsLabel(label);
  settingsBackend.value = label;
  showVersion(settingsRelease, label);
  const pane = $("#settings-sections")!;
  const nav = $("#settings-nav")!;
  pane.replaceChildren();
  nav.replaceChildren();
  const sections = label
    ? remoteSections
    : [...homeSections, ...remoteSections];
  const cats = (Object.keys(CATEGORY_LABELS) as Category[]).filter((cat) =>
    sections.some((s) => s.cat === cat),
  );
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_CATEGORY_KEY);
  } catch {}
  let current = cats.find((cat) => cat === last) ?? cats[0]!;
  let mounted: Category | null = null;
  const back = () => {
    if (settingsDepth() === 2) return history.back();
    show(current, false);
    nav.querySelector<HTMLElement>(`[data-cat="${current}"]`)?.focus();
  };
  const show = (cat: Category, drill: boolean) => {
    settingsModal.classList.toggle("drilled", drill);
    for (const btn of nav.querySelectorAll("button"))
      btn.classList.toggle("on", btn.dataset.cat === cat);
    current = cat;
    if (mounted === cat && (!phoneSettings.matches || drill)) return;
    cancelThemeCssPreview();
    closeSettingsDetails();
    pane.replaceChildren();
    mounted = null;
    if (phoneSettings.matches && !drill) return;
    const page = categoryPage(cat, back);
    page.hidden = false;
    pane.appendChild(page);
    for (const s of sections.filter((x) => x.cat === cat)) {
      const { section, body } = settingsSectionShell(
        s.title,
        PROVIDERS.has(s.title),
      );
      page.appendChild(section);
      s.build(body, closeSettings);
    }
    mounted = cat;
  };
  showCategory = show;
  for (const cat of cats) {
    const btn = categoryButton(cat);
    btn.onclick = () => {
      try {
        localStorage.setItem(LAST_CATEGORY_KEY, cat);
      } catch {}
      show(cat, true);
      const link = pane.querySelector<HTMLElement>(".settings-back");
      if (link?.offsetParent) {
        pushSettingsEntry(2);
        link.focus();
      }
    };
    nav.appendChild(btn);
  }
  show(current, false);
}
const phoneSettings = matchMedia("(max-width: 700px)");
const settingsDepth = (): number => Number(history.state?.settings) || 0;
phoneSettings.addEventListener("change", () => {
  if (!settingsOpen()) return;
  const category = $("#settings-nav button.on")?.dataset.cat as
    | Category
    | undefined;
  if (!category) return;
  if (phoneSettings.matches && $("#settings-sections .settings-cat")) {
    settingsModal.classList.add("drilled");
    if (settingsDepth() === 1) pushSettingsEntry(2);
  } else if (!phoneSettings.matches) showCategory(category, false);
  relayoutSettingsDetails();
});
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
    const selected = $("#settings-nav button.on")!;
    showCategory(selected.dataset.cat as Category, false);
    selected.focus();
  } else if (depth === 0) closeSettings();
});
export function closeSettings(): boolean {
  if (!settingsOverlay.classList.contains("on")) return false;
  cancelThemeCssPreview();
  closeSettingsDetails();
  $("#settings-sections")!.replaceChildren();
  $("#settings-nav")!.replaceChildren();
  hideVersion(settingsRelease);
  showCategory = () => {};
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
function buildPasswordSection(body: HTMLElement): void {
  body.dataset.themeProtected = "change-password";
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
      const r = await homeJpost(
        "/api/password",
        {
          current: val("current"),
          new: val("new"),
        },
        { renewsSession: true },
      );
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
}

function buildDeletedHistorySection(body: HTMLElement): void {
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
}

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

function buildMcpSection(body: HTMLElement): void {
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
}

function buildSessionSection(body: HTMLElement): void {
  body.innerHTML = `
    <div class="group"><button type="button" class="item danger">Log out</button></div>`;
  body.querySelector("button")!.onclick = async () => {
    clearSkillsCache();
    try {
      await homeJpost("/logout");
    } catch {}
    location.reload();
  };
}
