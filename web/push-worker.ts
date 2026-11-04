// Service worker for agent-finished notifications, served as /push-worker.js
// at root scope. Only push and notificationclick: no fetch handler, so it never
// changes how pages load. Every received push shows a notification; visible
// conversation suppression happens before sending. A tap opens the agent.
(() => {
  interface Notice {
    cid: string;
    title: string;
    body: string;
  }
  interface Tab {
    url: string;
    frameType: string;
    focus(): Promise<Tab>;
    postMessage(message: unknown): void;
  }
  interface WaitEvent {
    waitUntil(work: Promise<unknown>): void;
  }
  interface Worker {
    registration: {
      showNotification(
        title: string,
        options: NotificationOptions,
      ): Promise<void>;
    };
    clients: {
      matchAll(options: {
        type: "window";
        includeUncontrolled: boolean;
      }): Promise<Tab[]>;
      openWindow(url: string): Promise<unknown>;
    };
    addEventListener(
      type: "push",
      listener: (
        event: WaitEvent & { data: { json(): unknown } | null },
      ) => void,
    ): void;
    addEventListener(
      type: "notificationclick",
      listener: (event: WaitEvent & { notification: Notification }) => void,
    ): void;
  }
  const worker = self as unknown as Worker;
  const tabs = async () =>
    (
      await worker.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
    ).filter(
      (tab) =>
        tab.frameType === "top-level" &&
        new URL(tab.url).searchParams.get("embed") !== "1",
    );
  const showing = (tab: Tab, cid: string) =>
    new URLSearchParams(new URL(tab.url).hash.slice(1)).get("agent") === cid;

  worker.addEventListener("push", (event) => {
    const notice = event.data?.json() as Notice | undefined;
    if (!notice || typeof notice.cid !== "string") return;
    event.waitUntil(
      worker.registration.showNotification(notice.title, {
        body: notice.body,
        icon: "/static/brand/app-icon-192.png",
        tag: `agent-${notice.cid}`,
        data: { cid: notice.cid },
      }),
    );
  });

  const openAgent = async (cid: string) => {
    const open = await tabs();
    const tab = open.find((each) => showing(each, cid)) ?? open[0];
    if (tab === undefined) {
      await worker.clients.openWindow(
        `/#${new URLSearchParams({ agent: cid })}`,
      );
      return;
    }
    tab.postMessage({ openAgent: cid });
    await tab.focus();
  };
  // Spec: the Settings browser test runs a tap's action through this name.
  Object.assign(worker, { openAgent });

  worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const cid = String((event.notification.data as Notice | null)?.cid ?? "");
    event.waitUntil(openAgent(cid));
  });
})();
