// Durable warming ports Pi 1.4.0 core/cache-warmer.js (MIT, Mario Zechner).
// Replace with Pi's export when available. Exact wrapped replays have no
// generation hooks, idle warming or retries; compaction shares the timer.
// Bounded timer/admission policy: specs/tla/IdleCompaction.tla, not refinement.
/*
 * Copyright (c) 2025 Mario Zechner, MIT.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { copyJson } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  calculateCost,
  type Api,
  type Context,
  type Model,
  type Models,
  type ModelsSimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import {
  CompactionTask,
  GenerationTask,
  defineExtension,
  hook,
  type Conversation,
} from "@earendil-works/pi-durable";
import { recordUsage } from "../../../../node_modules/@earendil-works/pi-durable/dist/harness/usage.js";

const MAX_WARMING_AGE_MS = 60 * 60_000;
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;

export interface WarmingClock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}
const clock: WarmingClock = {
  now: Date.now,
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

interface Run {
  model: Model<Api>;
  request: { context: Context; options: ModelsSimpleStreamOptions };
  startedAt: number;
  delay: number;
  ttl: number;
  tokens: number;
  cachedAt: number;
  responded: boolean;
  canWarm: boolean;
  refreshing?: boolean;
  mode?: "warm" | "compact";
  conversationId?: Conversation["id"];
  controller: AbortController;
  cancelTimer?: () => void;
  removeAbort?: () => void;
}

export function createCacheWarm(options: {
  models(): Models;
  enabled(): boolean;
  compactIdle(): boolean;
  minimumTokens(): number;
  compact(cid: string, allowed: () => boolean): Promise<unknown>;
  busy(cid: string, includeBackground?: boolean): boolean;
  current(cid: string, model: Model<Api>): boolean;
  owner(id: Conversation["id"]): string;
  conversationId(cid: string): Conversation["id"] | undefined;
  conversation(id: Conversation["id"]): Promise<Conversation>;
  clock?: WarmingClock;
  changed(cid: string): void;
  report(error: unknown): void;
}) {
  const time = options.clock ?? clock;
  const runs = new Map<string, Run>();
  let closed = false;
  const cancel = (cid: string) => {
    const run = runs.get(cid);
    runs.delete(cid);
    run?.cancelTimer?.();
    run?.removeAbort?.();
    run?.controller.abort();
  };
  const valid = (cid: string, run: Run) =>
    !closed && runs.get(cid) === run && options.current(cid, run.model);
  const reconcile = () => {
    for (const [cid, run] of runs) {
      if (!valid(cid, run)) {
        cancel(cid);
        continue;
      }
      const busy = options.busy(cid);
      if (run.refreshing && (!busy || !options.enabled())) {
        run.controller.abort();
        if (options.compactIdle()) continue;
      }
      const compactBusy = options.busy(cid, options.enabled());
      if (run.mode === "compact" && compactBusy) {
        cancel(cid);
        continue;
      }
      const mode =
        busy && options.enabled() && run.canWarm
          ? "warm"
          : !compactBusy &&
              options.compactIdle() &&
              run.responded &&
              run.tokens >= options.minimumTokens()
            ? "compact"
            : undefined;
      if (mode === undefined) {
        if (!busy || !options.compactIdle()) cancel(cid);
        else {
          run.cancelTimer?.();
          run.cancelTimer = undefined;
          run.mode = undefined;
        }
      } else if (mode !== run.mode) {
        run.cancelTimer?.();
        run.cancelTimer = undefined;
        run.mode = mode;
        schedule(cid, run);
      }
    }
  };
  const price = (model: Model<Api>, tokens: Partial<Usage>) =>
    calculateCost(model, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...tokens,
    }).total;
  const schedule = (cid: string, run: Run) => {
    run.cancelTimer?.();
    run.cancelTimer = undefined;
    const next = run.cachedAt + run.delay;
    const deadline = next + Math.floor((run.ttl - run.delay) / 2);
    if (!valid(cid, run) || time.now() > deadline) {
      cancel(cid);
      return;
    }
    if (run.mode === "warm" && next > run.startedAt + MAX_WARMING_AGE_MS) {
      run.canWarm = false;
      reconcile();
      return;
    }
    run.cancelTimer = time.schedule(
      () => {
        run.cancelTimer = undefined;
        const allowed = () =>
          valid(cid, run) &&
          options.compactIdle() &&
          run.tokens >= options.minimumTokens() &&
          !options.busy(cid, options.enabled()) &&
          time.now() <= deadline;
        const work =
          run.mode === "compact"
            ? allowed()
              ? options.compact(cid, allowed).finally(() => {
                  if (runs.get(cid) === run) cancel(cid);
                })
              : Promise.resolve(cancel(cid))
            : refresh(cid, run, deadline);
        void work.catch((error) => {
          if (runs.get(cid) === run) cancel(cid);
          options.report(error);
        });
      },
      Math.max(0, next - time.now()),
    );
  };
  const refresh = async (cid: string, run: Run, deadline: number) => {
    if (
      !valid(cid, run) ||
      !options.enabled() ||
      !options.busy(cid) ||
      time.now() > deadline
    )
      return cancel(cid);
    const cacheHitCost = price(run.model, { cacheRead: run.tokens });
    const cacheMissCost = price(
      run.model,
      run.model.cost.cacheWrite > 0
        ? { cacheWrite: run.tokens }
        : { input: run.tokens },
    );
    const warmCost = price(run.model, { cacheRead: run.tokens, output: 1 });
    const missCost = Math.max(0, cacheMissCost - cacheHitCost);
    if (!(missCost - warmCost >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS)) {
      run.canWarm = false;
      reconcile();
      return;
    }
    run.refreshing = true;
    run.controller = new AbortController();
    let refreshed = false;
    const refreshedAt = time.now();
    try {
      const message = await options
        .models()
        .streamSimple(run.model, run.request.context, {
          ...run.request.options,
          maxTokens: 1,
          maxRetries: 0,
          signal: run.controller.signal,
        })
        .result();
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        run.cachedAt = refreshedAt;
        refreshed = true;
        const id = run.conversationId;
        if (id !== undefined && !closed) {
          const target = await options.conversation(id);
          await target.commit(async (tx) => {
            await recordUsage(
              tx,
              id,
              "models",
              `${message.provider}/${message.responseModel ?? message.model}`,
              message.usage,
            );
            await tx.appendEntry(id, {
              kind: "recurse.cache-warm",
              data: {
                type: "usage",
                usageType: "cache_warm",
                provider: message.provider,
                model: `${message.provider}/${message.responseModel ?? message.model}`,
                usage: copyJson(message.usage, {
                  omitUndefinedProperties: true,
                }),
                at: time.now(),
              },
            });
          }, context);
          options.changed(cid);
        }
      }
    } catch {
      // Invariant: Best-effort warming never fails an agent's work.
    }
    run.refreshing = false;
    if (runs.get(cid) === run) {
      // Invariant: Failed replays cannot extend a provider cache's lifetime.
      if (!refreshed) run.canWarm = false;
      run.mode = undefined;
      reconcile();
    }
  };
  return {
    cancel,
    reconcile,
    close() {
      closed = true;
      for (const cid of runs.keys()) cancel(cid);
    },
    capture(
      cid: string,
      capture: { method: string },
      model: Model<Api>,
      requestContext: Context,
      requestOptions?: Record<string, unknown>,
    ) {
      cancel(cid);
      if (
        closed ||
        (!options.enabled() && !options.compactIdle()) ||
        capture.method !== "streamSimple"
      )
        return;
      const signal = requestOptions?.signal as AbortSignal | undefined;
      const streamOptions = requestOptions as
        | ModelsSimpleStreamOptions
        | undefined;
      const canWarm = !(
        streamOptions?.reasoning &&
        model.api === "anthropic-messages" &&
        (model.compat as { forceAdaptiveThinking?: boolean } | undefined)
          ?.forceAdaptiveThinking !== true
      );
      const retention =
        streamOptions?.cacheRetention ??
        (getProviderEnvValue("PI_CACHE_RETENTION") === "long"
          ? "long"
          : "short");
      const seconds =
        retention === "none" ? undefined : model.promptCache?.[retention];
      if (seconds === undefined || seconds * 1000 <= 10_000 || signal?.aborted)
        return;
      const ttl = seconds * 1000;
      const request = {
        context: requestContext,
        options: { ...streamOptions, signal: undefined, onPayload: undefined },
      };
      const previous = request.context.messages.findLast(
        (message) => message.role === "assistant",
      );
      const usage = previous?.role === "assistant" ? previous.usage : undefined;
      const run: Run = {
        model,
        request,
        ttl,
        delay: Math.max(1, Math.floor(Math.min(ttl * 0.9, ttl - 10_000))),
        startedAt: time.now(),
        cachedAt: time.now(),
        responded: false,
        canWarm,
        tokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
        conversationId: options.conversationId(cid),
        controller: new AbortController(),
      };
      runs.set(cid, run);
      const aborted = () => {
        if (runs.get(cid) === run) cancel(cid);
      };
      signal?.addEventListener("abort", aborted, { once: true });
      run.removeAbort = () => signal?.removeEventListener("abort", aborted);
      reconcile();
    },
    extension: defineExtension({
      name: "recurse-cache-warm",
      hooks: [
        hook(GenerationTask, {
          afterResponse(message, api) {
            const cid = options.owner(api.conversationId);
            const run = runs.get(cid);
            if (run) {
              run.conversationId = api.conversationId;
              run.responded = true;
              run.tokens =
                message.usage.input +
                message.usage.cacheRead +
                message.usage.cacheWrite;
              run.removeAbort?.();
              run.removeAbort = undefined;
            }
          },
        }),
        hook(CompactionTask, {
          beforeCompact(_input, api) {
            cancel(options.owner(api.conversationId));
            return undefined;
          },
        }),
      ],
    }),
  };
}
