// A detached pass over live Pi records, non-roots before roots. Cloning holds a
// file lease; guarded handoff closes Pi and verifies its process groups. The
// published marker commits the backend; metadata scans recover it after
// crashes. Failures expose retry state; unsafe records defer without writes.
import { setImmediate } from "node:timers/promises";
import {
  canonicalMetadata,
  type ConversationRecord,
  type ConversationStore,
} from "../conversation_store";
import type { DurableHost } from "../durable/host";
import type { AgentNodes } from "../runtime/agent_nodes";
import type { AgentNode, NodeStore } from "../runtime/agent_node";
import type { ParkedActions } from "../compaction";
import type { ProcessLifecycle } from "../../process_lifecycle";
import type { ShellRegistry } from "../../pi_bg_shell";

type Rec = ConversationRecord;
export interface SwitchoverDeps {
  conversations: ConversationStore;
  durable: DurableHost;
  nodes: AgentNodes<AgentNode, NodeStore>;
  parked: ParkedActions;
  shells: ShellRegistry;
  processes: ProcessLifecycle;
  hasReports(cid: string): boolean;
  now(): number;
  log(event: string, fields: Rec): void;
}
const settingsKey = (conv: Rec) => JSON.stringify(canonicalMetadata(conv));

export class PiSwitchover {
  private readonly importing = new Map<string, Promise<void>>();
  constructor(private readonly deps: SwitchoverDeps) {}

  attempt(conv: Rec, signal: AbortSignal): Promise<void> {
    const cid = String(conv.id);
    const current = this.importing.get(cid);
    if (current) return current;
    const work = this.importRecord(conv, signal).finally(() =>
      this.importing.delete(cid),
    );
    this.importing.set(cid, work);
    return work;
  }

  private busy(conv: Rec): boolean {
    const cid = String(conv.id);
    return Boolean(
      !this.deps.nodes.ownerAdmits(cid) ||
      conv.reap_deferred ||
      !conv.session_id ||
      !conv.session_file,
    );
  }

  private async eligible(conv: Rec): Promise<boolean> {
    if (this.busy(conv) || !(await this.deps.durable.supportsImport(conv)))
      return false;
    const snapshot: Rec = {};
    return (
      !(await this.deps.shells.hasLiveShell(
        String(conv.session_id),
        snapshot,
      )) && snapshot.shell_status !== "unavailable"
    );
  }

  private note(cid: string, state: Rec): Promise<void> {
    return this.deps.conversations.withTitleGuard(cid, async (token) => {
      const conv = this.deps.conversations.load(cid, { withPending: false });
      if (!conv || conv.backend === "durable" || conv.reap_deferred) return;
      const change = {
        ...state,
        reason: `Import pending: ${state.reason} Retrying automatically; check Settings and server logs if this persists.`,
      };
      conv.backend_change = change;
      await this.deps.conversations.save(conv, token);
    });
  }

  private retryDue(conv: Rec): boolean {
    const at = (conv.backend_change as Rec | undefined)?.retry_at;
    return typeof at !== "number" || at <= this.deps.now();
  }

  private async importRecord(conv: Rec, signal: AbortSignal): Promise<void> {
    const { conversations, durable, nodes, processes } = this.deps;
    const cid = String(conv.id),
      node = nodes.node(cid, conversations.agentStore);
    let leased = false;
    try {
      if (!this.retryDue(conv)) return;
      if (!conv.session_id || !conv.session_file)
        throw new Error(
          "The original session binding is missing; restore it before importing history.",
        );
      if (!(await durable.supportsImport(conv)))
        throw new Error(
          "The stored model is unavailable; select an available model in Settings.",
        );
      if (!(await this.eligible(conv))) return;
      await durable.yieldToFocus();
      signal.throwIfAborted();
      if (!(leased = node.tryAdmitFileOp())) return;
      const original = settingsKey(conv);
      let blocked = false;
      const state = () => {
        const current = conversations.load(cid, { withPending: false });
        return {
          running:
            blocked ||
            !current ||
            this.busy(current) ||
            settingsKey(current) !== original,
          queued: 0,
        };
      };
      const publish = (commit: () => Promise<void>) =>
        conversations.withConfigurationMetadataGuard(cid, async () => {
          const current = conversations.load(cid, { withPending: false });
          blocked = !current || !(await this.eligible(current));
          if (blocked) return commit();
          const groups = [...processes.rows]
            .filter(([, row]) => row.cid === cid)
            .map(([id, row]) => ({
              id,
              row: { ...row },
              owner: processes.owned.get(id),
            }));
          for (const group of groups) {
            if (await processes.stopGroup(group.row)) continue;
            processes.rows.set(group.id, group.row);
            if (group.owner) processes.owned.set(group.id, group.owner);
            throw new Error("Pi process group cleanup is unverified.");
          }
          await commit();
          conversations.publishImportedBackend(cid);
        });
      conv = { ...conv, workdir: conversations.effectiveWorkdir(conv) };
      const result = await durable.importPi(conv, { state, publish }, signal);
      if (result.status !== "deferred")
        this.deps.log("pi_switchover_complete", {
          conversation_id: cid,
          entries: result.entries,
        });
    } catch (error) {
      if (signal.aborted) throw error;
      const attempt =
        Number((conv.backend_change as Rec | undefined)?.attempt ?? 0) + 1;
      const reason = error instanceof Error ? error.message : String(error);
      const retry_at =
        this.deps.now() + Math.min(300, 2 ** Math.min(attempt, 9));
      this.deps.log("pi_switchover_failed", {
        conversation_id: cid,
        reason,
        retry_at,
      });
      await this.note(cid, { state: "failed", attempt, retry_at, reason });
    } finally {
      if (leased) node.releaseFileOp();
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const records = this.deps.conversations.legacyConvs();
    const children = records.filter((conv) => conv.parent != null);
    for (const conv of children) {
      signal.throwIfAborted();
      await this.attempt(conv, signal);
      await setImmediate();
    }
    for (const child of children) {
      const current = this.deps.conversations.load(String(child.id), {
        withPending: false,
      });
      if (
        current &&
        current.backend !== "durable" &&
        this.retryDue(current) &&
        (await this.eligible(current))
      )
        return;
    }
    for (const conv of records.filter((conv) => conv.parent == null)) {
      signal.throwIfAborted();
      await this.attempt(conv, signal);
      await setImmediate();
    }
  }
}
