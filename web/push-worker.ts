// Agent-finished notification worker, served at /push-worker.js at root scope.
// No fetch handler: app loading and authentication stay with the server.
// Every push shows a notification; visible-view suppression is server-side.
// Clicks reuse only app pages, falling back to an absolute conversation URL.
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
      scope: string;
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
      openWindow(url: string): Promise<Tab | null>;
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
  const appUrl = new URL("/", worker.registration.scope);
  const tabs = async () =>
    (
      await worker.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
    ).filter((tab) => {
      const url = new URL(tab.url);
      return (
        tab.frameType === "top-level" &&
        url.origin === appUrl.origin &&
        url.pathname === appUrl.pathname &&
        url.searchParams.get("embed") !== "1"
      );
    });
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
    open.sort((a, b) => Number(showing(b, cid)) - Number(showing(a, cid)));
    for (const tab of open) {
      try {
        await tab.focus();
        tab.postMessage({ openAgent: cid });
        return;
      } catch {}
    }
    const target = new URL(appUrl);
    target.hash = new URLSearchParams({ agent: cid }).toString();
    const opened = await worker.clients.openWindow(target.href);
    await opened?.focus();
  };

  worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const cid = String((event.notification.data as Notice | null)?.cid ?? "");
    event.waitUntil(openAgent(cid));
  });
})();
