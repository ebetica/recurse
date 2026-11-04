// Subscription usage limits under a Claude or ChatGPT sign-in section: each
// window's share left and when it resets, as the latest model response
// reported (`usage_limits` on the login's status). Nothing here polls; the
// rows change when the section reads the status again.

interface UsageWindow {
  minutes: number;
  used_percent: number;
  resets_at: number | null;
}

export interface UsageLimits {
  checked_at: number;
  windows: UsageWindow[];
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** "14:05" today, "Tue 09:00" within six days, else "Nov 4 09:00". */
export function usageTime(at: number, now: number): string {
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  const day = date.toLocaleDateString(
    undefined,
    Math.abs(at - now) < 6 * DAY_MS
      ? { weekday: "short" }
      : { month: "short", day: "numeric" },
  );
  return `${day} ${clock}`;
}

const windowName = (minutes: number) =>
  minutes === 7 * 24 * 60
    ? "Weekly"
    : minutes % (24 * 60) === 0
      ? `${minutes / (24 * 60)}-day`
      : `${Math.round(minutes / 60)}-hour`;

const element = (tag: string, className: string, text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

function windowRow(usage: UsageWindow, now: number): HTMLElement {
  const name = windowName(usage.minutes);
  const reset = usage.resets_at;
  const row = element("div", "usage-row");
  row.append(element("span", "usage-name", name));
  // Spec: After its reset the window's usage is unknown until a response says.
  if (reset !== null && reset <= now) {
    row.append(
      element(
        "span",
        "usage-text",
        `Reset at ${usageTime(reset, now)}; no newer data`,
      ),
    );
    return row;
  }
  const left = 100 - Math.min(100, Math.max(0, Math.round(usage.used_percent)));
  const bar = element("div", left <= 10 ? "usage-bar high" : "usage-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", `${name} remaining`);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(left));
  const fill = element("span", "");
  fill.style.width = `${left}%`;
  bar.append(fill);
  row.append(
    element(
      "span",
      "usage-text",
      `${left}% left` +
        (reset === null ? "" : `, resets ${usageTime(reset, now)}`),
    ),
    bar,
  );
  return row;
}

/** Show `status`'s usage limits below the section's sign-in buttons; a
 * subscription login without any yet says when they will appear. */
export function showUsageLimits(
  body: HTMLElement,
  status:
    | { configured?: boolean; type?: string; usage_limits?: UsageLimits }
    | undefined,
): void {
  body.querySelector(".usage-limits")?.remove();
  const limits = status?.usage_limits;
  if (!limits && !(status?.configured && status.type !== "api_key")) return;
  const box = element("div", "usage-limits");
  const now = Date.now();
  if (!limits) box.append(element("p", "hint", "No usage data yet"));
  else {
    for (const usage of [...limits.windows].sort(
      (a, b) => a.minutes - b.minutes,
    ))
      box.append(windowRow(usage, now));
    box.append(
      element("p", "hint", `As of ${usageTime(limits.checked_at, now)}`),
    );
  }
  body.querySelector(".row")?.after(box);
}
