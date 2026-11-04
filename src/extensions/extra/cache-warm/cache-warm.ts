// Busy-only Durable warming: pi-coding-agent 1.4.0 dist/core/cache-warmer.js
// (MIT, Mario Zechner) streaming-only port; its exports block direct imports.
// Replace with Pi’s export when available. Replay exact captures through
// provider wrappers, without generation hooks, idle warming or retries.
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
import { copyJson } from "@earendil-works/chord";
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
  conversationId?: Conversation["id"];
  controller: AbortController;
  cancelTimer?: () => void;
  removeAbort?: () => void;
}

export function createCacheWarm(options: {
  models(): Models;
  enabled(): boolean;
  busy(cid: string): boolean;
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
    !closed &&
    runs.get(cid) === run &&
    options.enabled() &&
    options.busy(cid) &&
    options.current(cid, run.model);
  const reconcile = () => {
    for (const [cid, run] of runs) if (!valid(cid, run)) cancel(cid);
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
    const next = time.now() + run.delay;
    if (next > run.startedAt + MAX_WARMING_AGE_MS || !valid(cid, run)) {
      cancel(cid);
      return;
    }
    const deadline = next + Math.floor((run.ttl - run.delay) / 2);
    run.cancelTimer = time.schedule(() => {
      run.cancelTimer = undefined;
      void refresh(cid, run, deadline).catch((error) => {
        if (runs.get(cid) === run) cancel(cid);
        options.report(error);
      });
    }, run.delay);
  };
  const refresh = async (cid: string, run: Run, deadline: number) => {
    if (!valid(cid, run) || time.now() > deadline) return cancel(cid);
    const cacheHitCost = price(run.model, { cacheRead: run.tokens });
    const cacheMissCost = price(
      run.model,
      run.model.cost.cacheWrite > 0
        ? { cacheWrite: run.tokens }
        : { input: run.tokens },
    );
    const warmCost = price(run.model, { cacheRead: run.tokens, output: 1 });
    const missCost = Math.max(0, cacheMissCost - cacheHitCost);
    if (!(missCost - warmCost >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS))
      return cancel(cid);
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
    if (runs.get(cid) === run) schedule(cid, run);
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
      if (closed || !options.enabled() || capture.method !== "streamSimple")
        return;
      const signal = requestOptions?.signal as AbortSignal | undefined;
      const streamOptions = requestOptions as
        | ModelsSimpleStreamOptions
        | undefined;
      if (
        streamOptions?.reasoning &&
        model.api === "anthropic-messages" &&
        (model.compat as { forceAdaptiveThinking?: boolean } | undefined)
          ?.forceAdaptiveThinking !== true
      )
        return;
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
      schedule(cid, run);
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
