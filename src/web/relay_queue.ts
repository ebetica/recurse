// Relay messages for homes not polling a sleeping instance, on disk so they
// survive a stop (RECURSE_SLEEP_WHEN_IDLE only); at most 20 per home address,
// 200 in all. Keyed by address (label.ts); older label-keyed files migrate on
// load. Writes are serialized and atomic; the file holds no credentials.
import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { keyedLabel } from "../backends/label";
import type { RelayRequest } from "./relay_inbox";

const PER_LABEL = 20;
const TOTAL = 200;
const LABELS = 100;

interface Route {
  name: string;
  key: string | null;
  /** The label the home polls with; absent in older files (the address). */
  label?: string;
}
export interface QueueRoute {
  address: string;
  name: string;
  key: string | null;
  label: string;
}
interface QueueFile {
  labels: Record<string, Route>;
  requests: RelayRequest[];
}

export class RelayQueue {
  private file?: QueueFile;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly keys: { list(): Promise<{ id: string }[]> },
    private readonly warn: (reason: string) => void = () => {},
  ) {}

  private async load(): Promise<QueueFile> {
    if (this.file) return this.file;
    let text: string | null = null;
    try {
      text = await readFile(this.path, "utf8");
      const data = JSON.parse(text) as Partial<QueueFile>;
      if (
        !data ||
        typeof data.labels !== "object" ||
        !Array.isArray(data.requests)
      )
        throw new Error("unexpected shape");
      this.file = { labels: data.labels ?? {}, requests: data.requests };
      for (const [old, route] of Object.entries(this.file.labels)) {
        if (route.label !== undefined) continue;
        const address = route.key ? keyedLabel(old, route.key) : old;
        delete this.file.labels[old];
        this.file.labels[address] = { ...route, label: old };
        for (const request of this.file.requests)
          if (request.label === old) request.label = address;
      }
    } catch (error) {
      if (text !== null) this.warn(String(error));
      this.file = { labels: {}, requests: [] };
    }
    return this.file;
  }
  /** Read after pending writes so removed requests are not offered again. */
  private async read(): Promise<QueueFile> {
    await this.writes;
    return this.load();
  }
  private change(edit: (file: QueueFile) => boolean): Promise<void> {
    const task = this.writes.then(async () => {
      const file = await this.load();
      if (!edit(file)) return;
      const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const handle = await open(tmp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(file));
        } finally {
          await handle.close();
        }
        await rename(tmp, this.path);
      } finally {
        await unlink(tmp).catch(() => {});
      }
    });
    this.writes = task.catch(() => {});
    return task;
  }
  /** Routes whose backend key still exists (keyless homes always do). */
  private async live(): Promise<Record<string, Route>> {
    const { labels } = await this.read();
    const keys = new Set((await this.keys.list()).map((k) => k.id));
    return Object.fromEntries(
      Object.entries(labels).filter(([, r]) => !r.key || keys.has(r.key)),
    );
  }
  /**
   * Routes for `target`: with `keyed`, the keyed address equal to it;
   * otherwise those whose home polls with the label `target`.
   */
  async routes(target: string, keyed: boolean): Promise<QueueRoute[]> {
    return Object.entries(await this.live()).flatMap(([address, r]) => {
      const label = r.label ?? address;
      return (
        keyed ? address === target && address !== label : label === target
      )
        ? [{ address, name: r.name, key: r.key, label }]
        : [];
    });
  }
  /**
   * Remember a polling home's labels; forget any sharing one keyed address
   * and drop requests queued at an address for another label.
   */
  learn(labels: string[], name: string, key: string | null): Promise<void> {
    const address = (label: string) => (key ? keyedLabel(label, key) : label);
    const shared = new Set(
      labels
        .filter(
          (l, i) => labels.findIndex((m) => address(m) === address(l)) !== i,
        )
        .map(address),
    );
    return this.change((file) => {
      const same = (label: string, r?: Route) =>
        r?.name === name && r.key === key && r.label === label;
      if (
        labels.every((l) =>
          shared.has(address(l))
            ? !file.labels[address(l)]
            : same(l, file.labels[address(l)]),
        )
      )
        return false;
      for (const label of labels) {
        const before = file.labels[address(label)];
        if (before && (before.label !== label || shared.has(address(label))))
          file.requests = file.requests.filter(
            (r) => r.label !== address(label),
          );
        delete file.labels[address(label)];
        if (shared.has(address(label))) continue;
        file.labels[address(label)] = { name, key, label };
      }
      const all = Object.keys(file.labels);
      for (const label of all.slice(0, Math.max(0, all.length - LABELS)))
        delete file.labels[label];
      return true;
    });
  }
  /** Queue a request; returns the ids of older requests dropped for room. */
  async add(request: RelayRequest): Promise<string[]> {
    let dropped: string[] = [];
    await this.change((file) => {
      file.requests.push(request);
      const mine = file.requests.filter((r) => r.label === request.label);
      const drop = new Set([
        ...mine.slice(0, -PER_LABEL),
        ...file.requests.slice(0, -TOTAL),
      ]);
      dropped = [...drop].map((r) => r.id);
      file.requests = file.requests.filter((r) => !drop.has(r));
      return true;
    });
    return dropped;
  }
  /**
   * Queued requests for `labels` learned from the home with `key`, with the
   * address each was queued under and its label rewritten to the home's.
   */
  async for(
    labels: string[],
    key: string | null,
  ): Promise<{ request: RelayRequest; address: string }[]> {
    const routes = await this.live();
    const { requests } = await this.read();
    return requests.flatMap((r) => {
      const route = routes[r.label];
      const label = route?.label ?? r.label;
      return route?.key === key && labels.includes(label)
        ? [{ request: { ...r, label }, address: r.label }]
        : [];
    });
  }
  remove(id: string): Promise<void> {
    return this.change((file) => {
      const before = file.requests.length;
      file.requests = file.requests.filter((r) => r.id !== id);
      return file.requests.length !== before;
    });
  }
}
