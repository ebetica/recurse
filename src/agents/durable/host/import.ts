// Import external history into Durable storage off the event loop: an agent
// archive, or a Pi session converted in place. Neither opens a Harness that
// can run tools.
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { readEnvironmentOverrides } from "../../../extensions/core/safety/environment-state";
import type { ArchivedAgent } from "../archive.ts";
import type { DurableHost } from "../host.ts";
import type { PiImportOptions, PiImportResult } from "../import_pi_session";
import { modelRef } from "../model_selection";
import { runtime } from "./load.ts";

type Rec = Record<string, unknown>;
type ThinkingLevel = PiImportOptions["settings"]["thinkingLevel"];

/** Validate and copy an archive into the agent archive, before an agent is
 * created from it. */
export async function importArchive(
  host: DurableHost,
  path: string,
): Promise<ArchivedAgent> {
  const { importArchive } = await import("../import_archive");
  const [model, effort] = host.deps.settings({});
  return importArchive(path, {
    archive: host.archive,
    trashDir: host.deps.trashDir,
    models: await host.models(),
    settings: {
      model: modelRef(model),
      thinkingLevel: effort as ThinkingLevel,
      cwd: host.deps.dataDir,
      environment: {},
      safetyOff: false,
    },
    log: host.deps.log,
  });
}

/** Whether the conversation's model can hold an imported Pi session. */
export async function supportsImport(
  host: DurableHost,
  conv: Rec,
): Promise<boolean> {
  const ref = modelRef(host.deps.settings(conv)[0]);
  return !!(await host.models()).getModel(ref.provider, ref.modelId);
}

/** Build historical storage only; never open a Harness that can run tools. */
export async function importPi(
  host: DurableHost,
  conv: Rec,
  options: Pick<PiImportOptions, "state" | "publish">,
  signal: AbortSignal,
): Promise<PiImportResult> {
  await host.yieldToFocus();
  const [{ importPiSession }, rt] = await Promise.all([
    import("../import_pi_session"),
    runtime(),
  ]);
  const overrides = await readEnvironmentOverrides(
    await host.deps.agentEnv(conv),
  );
  const [model, effort] = host.deps.settings(conv);
  // Invariant: Its own SQLite thread: an import's batched transactions never
  // queue behind (or ahead of) live conversations' statements on the shared
  // one.
  const worker = new rt.SqliteWorker();
  try {
    return await importPiSession(
      {
        conversationId: String(conv.id),
        sessionId: String(conv.session_id),
        sessionFile: String(conv.session_file),
        destination: join(host.storagePath(String(conv.id)), ".."),
        trashDir: host.deps.trashDir,
        models: await host.models(),
        worker,
        settings: {
          model: modelRef(model),
          thinkingLevel: effort as ThinkingLevel,
          cwd: String(conv.workdir ?? conv.session_cwd ?? host.deps.dataDir),
          environment: Object.fromEntries(
            [...overrides].map(([name, { value }]) => [name, value]),
          ),
          safetyOff: Boolean(conv.safety_off),
        },
        log: host.deps.log,
        ...options,
      },
      withAbortSignal(signal, context),
    );
  } finally {
    worker.close();
  }
}
