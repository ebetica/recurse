// Settings > Account: this browser's "agent finished" notifications. Turning
// them on asks for permission, registers /push-worker.js (web/push-worker.ts)
// at root scope and saves this device's push subscription on the server;
// turning them off removes both. Each browser opts in separately.
import { api, jpost } from "../api.js";
import { agentLinkUrl } from "../deep-link.js";

export const NOTIFY_LABEL = "Notify me when a top-level agent finishes";

const supported = () =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

async function subscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function turnOn(): Promise<string> {
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error(
      "Notifications are blocked for this site. Allow them in the browser's site settings.",
    );
  const keyResponse = await api("/api/settings/notifications");
  if (!keyResponse.ok) throw new Error("Couldn't load notification settings.");
  const { public_key } = (await keyResponse.json()) as { public_key: string };
  await navigator.serviceWorker.register("/push-worker.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(
    atob(public_key.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
  const subscribed = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const saved = await jpost("/api/settings/notifications/devices", {
    subscription: subscribed.toJSON(),
  });
  if (!saved.ok) {
    await subscribed.unsubscribe().catch(() => false);
    throw new Error("Couldn't save this device. Try again.");
  }
  return "This browser will be notified.";
}

async function turnOff(): Promise<string> {
  const current = await subscription();
  if (current !== null) {
    const removed = await jpost("/api/settings/notifications/devices/remove", {
      endpoint: current.endpoint,
    });
    if (!removed.ok) throw new Error("Couldn't turn notifications off.");
    await current.unsubscribe();
  }
  return "Notifications are off for this browser.";
}

export function buildNotificationsSection(body: HTMLElement): void {
  body.innerHTML = `
    <label class="row check"><input type="checkbox" name="notify">
      <span>${NOTIFY_LABEL}</span></label>
    <p class="hint">Only this browser. Agents you have taken over notify too.</p>
    <p class="msg"></p>`;
  const box = body.querySelector<HTMLInputElement>("input")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const show = (cls: string, text: string) => {
    msg.className = `msg ${cls}`;
    msg.textContent = text;
  };
  box.disabled = true;
  if (!supported()) {
    show(
      "",
      "This browser can't show notifications. On iPhone or iPad, add Recurse to the Home Screen and open it from there.",
    );
    return;
  }
  void subscription()
    .then((current) => {
      box.checked = current !== null;
    })
    .catch(() => {})
    .finally(() => {
      box.disabled = false;
    });
  box.addEventListener("change", async () => {
    box.disabled = true;
    show("", "");
    try {
      show("ok", box.checked ? await turnOn() : await turnOff());
    } catch (error) {
      box.checked = !box.checked;
      show("err", error instanceof Error ? error.message : String(error));
    } finally {
      box.disabled = false;
    }
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const cid = (event.data as { openAgent?: unknown } | null)?.openAgent;
    if (typeof cid === "string")
      location.href = agentLinkUrl(location.href, cid, false);
  });
  navigator.serviceWorker.startMessages();
}
