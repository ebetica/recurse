import type { DurableHost } from "../../../../src/agents/durable/host.ts";
import { DurableViews } from "../../../../src/agents/durable/durable_rows.ts";

export function holdStoragePage(host: DurableHost) {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const views = new DurableViews();
  const page = views.page.bind(views);
  views.page = async (...args) => {
    views.page = page;
    reached.resolve();
    await released.promise;
    return page(...args);
  };
  host.views = views;
  return { reached: reached.promise, release: () => released.resolve() };
}
