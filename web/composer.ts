// Snapshot targets/text into independent concurrent sends; retain failed work.
// Boot sends wait for authoritative selection; draft creation happens once.
// Own attachments/drafts/input; refuse reloads that would lose browser-only
// work or ambiguously replay a send.
import { treeOf } from "./backends/tree.js";
import {
  backendFor,
  conversationId,
  parseConversationId,
} from "./backends/backend.js";
import { currentUiOwnerId, state, DRAFT, LAST_AGENT_KEY } from "./state.js";
import { sharedTrees } from "./shared-trees.js";
import { $, inputEl, sendEl } from "./dom.js";
import { newClientMessageId } from "./composer/send.js";

import {
  selectAgent,
  renderSidebar,
  closeMobileSidebar,
  syncHistoryToSelection,
  asHistoryCorrection,
  refreshUpBtn,
} from "./sidebar.js";
import { renderDraft } from "./conversation/chrome.js";
import { poll, waitForInitialAuthoritativeRead } from "./conversation/poll.js";
import {
  addOptimisticPending,
  newestCommittedOffset,
} from "./pending-queue.js";
import { dropRowThread } from "./row-thread-state.js";
import {
  clearStopForNewTurn,
  prepareStopTarget,
  requestStop,
} from "./conversation/stop.js";
import { guardLeaveComments } from "./comments.js";
import {
  adoptDraftSkills,
  preloadSkills,
  refreshSkillAutocomplete,
  setComposerCommandRunner,
} from "./skills.js";
import {
  attachmentIdFromUrl,
  conversationCreationBody,
  conversationIdLease,
} from "./attachment-flow.js";
import {
  abandonStagedAttachments,
  hasAnyStagedAttachments,
  hasStagedAttachments,
  recoverableStagedAttachments,
  refreshAttachmentSendState,
  restoreStagedAttachments,
  setAttachmentInputBlocked,
  takeAttachmentsForSend,
  transferStagedAttachmentOwner,
} from "./attachments.js";
import { showSide } from "./side-pane.js";
import {
  COMPOSER_COMMAND_ENDPOINT,
  availableCommands,
  commandFeedback,
  matchComposerCommand,
  shouldDropHeldThread,
} from "./composer/commands.js";
import { requestUiRefresh } from "./ui-events.js";
import {
  parseAuthRecovery,
  resolveAuthRecoveryOwner,
  serializeAuthRecovery,
  type AuthRecovery,
} from "./connection/send-recovery.js";
import { closeComposerAutocomplete } from "./composer/autocomplete.js";
import {
  conversationUiState,
  newDraftUiOwnerId,
} from "./conversation-ui-state/store.js";
import {
  clearComposerOwner,
  composerHasVolatileWork,
  noteComposerInput,
  restoreComposerValue,
  snapshotComposerOwner,
  switchComposerOwner,
} from "./composer/view-state.js";
import { openAgentFinderRevive, openFoundAgent } from "./agent-finder/ui.js";
import type { DraftCreator } from "./types.js";
import { snapshotNewSubagentDefaults } from "./settings/preferences.js";
import {
  activateComposerControl,
  activeComposerStopPreparation,
  armPreparedComposerStop,
  consumeComposerStopHold,
  disarmComposerStop,
} from "./composer/action.js";

interface DraftSpec {
  parent: string | null;
  backendLabel?: string;
}

interface SendJob {
  draft: boolean;
  convId: string | null;
  content: string;
  attachmentIds: string[];
  // Retrying a job id replays its admitted ack, never a second send.
  clientId: string;
  retry: number;
  timer: number;
  inFlight: boolean;
  failed: boolean;
  waitingForSelection?: boolean;
  error?: string;
  waitFor?: DraftCreator;
  parent?: string | null;
  backendLabel?: string;
  model?: string | null;
  effort?: string | null;
  level?: number | null;
  attachmentDraft?: string | null;
  muted?: boolean;
  messageId?: string;
  sinceOffset?: number;
  steered?: boolean;
  convIdReady?: Promise<string>;
  resolveConvId?: (id: string) => void;
}

// Empty the typed composer after its content has been snapshotted into a send
// job. Attachments are cleared separately so the send path can transfer them
// without issuing the best-effort DELETE used for abandonment.
function clearComposer(ownerId = currentUiOwnerId()): void {
  clearComposerOwner(ownerId);
  closeComposerAutocomplete();
  autosize();
  refreshAttachmentSendState();
}

// Focus Insert mode without disturbing a draft. A keyboard entry always places
// the caret at the end, while an already-focused composer keeps its selection.
export function focusComposerAtEnd(): boolean {
  if (inputEl.disabled || inputEl.readOnly || !inputEl.isConnected)
    return false;
  const alreadyFocused = document.activeElement === inputEl;
  inputEl.focus();
  if (document.activeElement !== inputEl) return false;
  if (!alreadyFocused) {
    const end = inputEl.value.length;
    inputEl.setSelectionRange(end, end);
  }
  return true;
}

// Independent jobs own snapshotted targets/text, retries and visible failures.
const statusEl = $<HTMLButtonElement>("#send-status")!;
const MAX_ATTEMPTS = 6;
let jobs: SendJob[] = [];
let composerCommandStatusKey: string | null = null;
const AUTH_RECOVERY_KEY = "recurse.authRecovery.v1";
let pendingSavedRecovery: {
  owner: string | null;
  uiStateId: string;
} | null = null;
let pendingRecoveredAttachmentOwners: string[] = [];

function activeComposerOwnerId(): string {
  return pendingSavedRecovery?.uiStateId ?? currentUiOwnerId();
}

/** Put a refused message's text back in the composer, after any draft. */
export function resendText(text: string): void {
  const draft = inputEl.value.trimEnd();
  const value = draft ? `${draft}\n\n${text}` : text;
  restoreComposerValue(activeComposerOwnerId(), {
    text: value,
    selectionStart: value.length,
    selectionEnd: value.length,
  });
  autosize();
  focusComposerAtEnd();
}

// Explicitly leaving for login is the one navigation that cannot keep in-memory
// work alive. Snapshot it into this tab's sessionStorage first; after login the
// composer and failed-send queue are rebuilt without auto-sending anything.
export function preserveUnsentForLogin(): boolean {
  // Invariant: Hidden saved-agent drafts are safe only after their session-tier
  // flush. Refuse destructive login when storage is denied/quota-limited or an
  // over-bound legacy/programmatic value exists only in this tab.
  if (
    conversationUiState.hasUnpersistedComposerWork() ||
    composerHasVolatileWork()
  )
    return false;
  if (!hasUnsentComposerWork()) return true;
  // Invariant: Local files/unresolved owners cannot survive reload.
  // Non-idempotent mutations may commit ambiguously; refuse login until settled
  // rather than losing, leaking or blindly replaying uploads.
  const staged = recoverableStagedAttachments();
  if (staged === null || jobs.some((job) => job.inFlight)) return false;
  const recovery: AuthRecovery = {
    version: 1,
    owner: state.draft ? null : currentUiOwnerId(),
    input: inputEl.value,
    selectionStart: inputEl.selectionStart ?? inputEl.value.length,
    selectionEnd: inputEl.selectionEnd ?? inputEl.value.length,
    attachments: staged,
    draft: state.draft
      ? {
          parent: state.draft.parent,
          backendLabel: state.draft.backendLabel,
          creatorIndex: state.draft.creator
            ? jobs.indexOf(state.draft.creator as SendJob)
            : -1,
          model: state.draft.model,
          effort: state.draft.effort,
          level: state.draft.level,
          attachmentDraft: state.draft.attachmentDraft,
          muted: state.draft.muted,
        }
      : null,
    jobs: jobs.map((job) => ({
      // Invariant: A creator can leave jobs before its follower copies the id.
      // Resolve via the retained creator object so login cannot restore a null
      // target.
      draft: job.draft,
      convId: job.convId || job.waitFor?.convId || null,
      content: job.content,
      attachmentIds: job.attachmentIds,
      clientId: job.clientId,
      parent: job.parent,
      backendLabel: job.backendLabel,
      model: job.model,
      effort: job.effort,
      level: job.level,
      attachmentDraft: job.attachmentDraft,
      muted: job.muted,
      waitForIndex: job.waitFor ? jobs.indexOf(job.waitFor as SendJob) : -1,
    })),
  };
  const raw = serializeAuthRecovery(recovery);
  if (!raw) return false;
  try {
    sessionStorage.setItem(AUTH_RECOVERY_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

function restoreAfterLogin(): void {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(AUTH_RECOVERY_KEY);
    sessionStorage.removeItem(AUTH_RECOVERY_KEY);
  } catch {
    return;
  }
  const recovery = parseAuthRecovery(raw);
  if (!recovery) return;
  pendingRecoveredAttachmentOwners = [
    ...new Set(
      recovery.attachments
        .filter((item) => item.owner.kind === "owner")
        .map((item) => item.owner.id),
    ),
  ];

  const restored = recovery.jobs.map((saved): SendJob => {
    const creatorLease = saved.draft ? conversationIdLease(saved.convId) : null;
    return {
      draft: saved.draft,
      convId: saved.convId,
      content: saved.content,
      attachmentIds: saved.attachmentIds || [],
      // Invariant: A payload predating the idempotency key restores with a
      // fresh one; validated saves always carry the original job's id.
      clientId: saved.clientId ?? newClientMessageId(),
      parent: saved.parent,
      backendLabel: saved.backendLabel,
      model: saved.model,
      effort: saved.effort,
      level: typeof saved.level === "number" ? saved.level : null,
      attachmentDraft: saved.attachmentDraft,
      muted: saved.muted,
      convIdReady: creatorLease?.convIdReady,
      resolveConvId: creatorLease?.resolveConvId,
      retry: 0,
      timer: 0,
      inFlight: false,
      failed: true,
      error: "Message kept through login — Retry now",
    };
  });
  recovery.jobs.forEach((saved, index) => {
    if (saved.waitForIndex >= 0 && saved.waitForIndex < restored.length)
      restored[index].waitFor = restored[saved.waitForIndex];
  });
  jobs.push(...restored);
  if (recovery.draft) {
    const saved = recovery.draft;
    const creator =
      saved.creatorIndex >= 0 ? restored[saved.creatorIndex] : undefined;
    const uiStateId = newDraftUiOwnerId();
    snapshotComposerOwner(currentUiOwnerId());
    state.draft = {
      parent: typeof saved.parent === "string" ? saved.parent : null,
      backendLabel: saved.backendLabel,
      uiStateId,
      model: typeof saved.model === "string" ? saved.model : null,
      effort: typeof saved.effort === "string" ? saved.effort : undefined,
      level: typeof saved.level === "number" ? saved.level : null,
      attachmentDraft:
        typeof saved.attachmentDraft === "string"
          ? saved.attachmentDraft
          : undefined,
      muted: typeof saved.muted === "boolean" ? saved.muted : undefined,
      creator,
      pending: restored
        .filter((job) => job === creator || job.waitFor === creator)
        .map((job) => ({ role: "user", content: job.content })),
    };
    state.selectedId = DRAFT;
    state.cursorId = DRAFT;
    switchComposerOwner(uiStateId);
    restoreStagedAttachments(
      recovery.attachments.map((item) => ({
        ...item,
        uiOwnerId: item.uiOwnerId || uiStateId,
      })),
      (item) =>
        item.uiOwnerId.startsWith("draft:")
          ? uiStateId
          : item.owner.kind === "owner"
            ? item.owner.id
            : uiStateId,
    );
    restoreComposerValue(uiStateId, {
      text: recovery.input,
      selectionStart: recovery.selectionStart ?? recovery.input.length,
      selectionEnd: recovery.selectionEnd ?? recovery.input.length,
    });
    renderDraft();
  } else {
    // Invariant: Recovered saved-agent work stays visible but unsendable until
    // the first tree validates its exact owner; old-generation payloads may
    // require attachment/LAST_AGENT hints.
    let owner = recovery.owner;
    if (!owner) {
      const attachmentOwners = new Set(
        recovery.attachments
          .filter((item) => item.owner.kind === "owner")
          .map((item) => item.owner.id),
      );
      if (attachmentOwners.size === 1) owner = [...attachmentOwners][0];
      if (!owner)
        try {
          owner = localStorage.getItem(LAST_AGENT_KEY);
        } catch {}
    }
    const uiStateId = newDraftUiOwnerId();
    pendingSavedRecovery = { owner, uiStateId };
    switchComposerOwner(uiStateId);
    restoreStagedAttachments(
      recovery.attachments.map((item) => ({
        ...item,
        uiOwnerId: item.uiOwnerId || uiStateId,
      })),
      (item) =>
        item.owner.kind === "owner" && item.owner.id !== owner
          ? item.owner.id
          : uiStateId,
    );
    restoreComposerValue(uiStateId, {
      text: recovery.input,
      selectionStart: recovery.selectionStart ?? recovery.input.length,
      selectionEnd: recovery.selectionEnd ?? recovery.input.length,
    });
    setAttachmentInputBlocked(true);
  }
  autosize();
  refreshAttachmentSendState();
  renderSendStatus();
}

// A published frontend must not navigate over browser-only work. Generation
// recovery leaves one explicit retry visible until the user sends/cancels the
// draft, attachments finish/clear, and resilient jobs land.
export function hasUnsentComposerWork(): boolean {
  return (
    !!inputEl.value ||
    hasAnyStagedAttachments() ||
    jobs.length > 0 ||
    !!state.draft ||
    conversationUiState.hasUnpersistedComposerWork() ||
    composerHasVolatileWork()
  );
}

function setSendStatus(msg: string, kind?: string): void {
  statusEl.textContent = msg || "";
  statusEl.className = msg ? "show " + (kind || "") : "";
  statusEl.disabled = kind !== "error";
}

// Aggregate the jobs' states into the single status line: a failed batch (tap
// to retry), else any in-progress reconnection, else nothing on the fast path.
function renderSendStatus(): void {
  // Invariant: A real send owns the shared status surface from here; a late
  // response from an earlier command must not overwrite its retry/error state.
  composerCommandStatusKey = null;
  const failed = jobs.filter((j) => j.failed);
  const retrying = jobs.filter((j) => !j.failed && j.retry > 0);
  if (failed.length) {
    const detail = failed.find((j) => j.error)?.error;
    setSendStatus(
      detail ||
        `couldn't send ${failed.length} message${failed.length > 1 ? "s" : ""} — Retry now`,
      "error",
    );
  } else if (retrying.length) {
    if (
      backendFor(retrying[0]!.convId || "").connectionHealth.snapshot()
        .phase === "offline"
    )
      setSendStatus(
        "offline — will send when the connection returns",
        "pending",
      );
    else setSendStatus(`reconnecting… (${retrying.length} pending)`, "pending");
  } else if (jobs.some((job) => job.waitingForSelection)) {
    setSendStatus("Waiting for this agent to load…", "pending");
  } else {
    setSendStatus("", "");
  }
}
statusEl.onclick = () => {
  if (pendingSavedRecovery) return;
  if (!statusEl.classList.contains("error")) return;
  for (const j of jobs)
    if (j.failed) {
      j.failed = false;
      j.error = "";
      j.retry = 0;
      runJob(j);
    }
  renderSendStatus();
  const retrying = jobs.filter((j) => !j.failed && j.inFlight).length;
  if (retrying) setSendStatus(`Retrying… (${retrying} pending)`, "pending");
};

// One-shot platform commands never retry or become model prompts.
const runningComposerCommands = new Set<string>();

function setComposerCommandStatus(
  key: string,
  convId: string,
  text: string,
  kind = "",
  claim = false,
): void {
  if (!claim && composerCommandStatusKey !== key) return;
  if (state.selectedId !== convId) {
    if (composerCommandStatusKey === key) {
      composerCommandStatusKey = null;
      setSendStatus("", "");
    }
    return;
  }
  composerCommandStatusKey = key;
  setSendStatus(text, kind);
}

function composerCommandAvailable(name: string, convId: string): boolean {
  // Invariant: Side conversations and revive stay on the home backend.
  if (
    parseConversationId(convId).label &&
    (name === "btw" || name === "revive")
  )
    return false;
  const node = state.nodes[convId];
  return availableCommands({
    isDraft: convId === DRAFT,
    hasParent: !!node?.parent,
  }).some((command) => command.name === name);
}

async function runComposerCommand(
  name: string,
  convId: string,
  key: string,
  question?: string,
): Promise<void> {
  const endpoint = COMPOSER_COMMAND_ENDPOINT[name];
  if (!endpoint) {
    runningComposerCommands.delete(key);
    return;
  }
  setComposerCommandStatus(key, convId, `/${name}…`, "pending", true);
  try {
    // Invariant: This is an operator mutation, so failures participate in
    // global connection health. Never client-timeout an ambiguous committed
    // action.
    const r = await backendFor(convId).jpost(
      `/api/conversations/${convId}/${endpoint}`,
      name === "btw" ? { question } : {},
      { availability: "core", timeoutMs: 0 },
    );
    if (!r.ok) {
      setComposerCommandStatus(key, convId, `/${name} failed`, "command-error");
      return;
    }
    const data = (await r.json().catch(() => ({}))) as {
      id?: string;
      muted?: boolean;
      queued?: boolean;
    };
    const msg = commandFeedback(name, data);
    setComposerCommandStatus(key, convId, msg);
    if (name === "btw" && data.id) showSide(convId, data.id);
    if (shouldDropHeldThread(name, r.ok, !!data.queued)) dropRowThread(convId);
    // Invariant: Auto-dismiss only this command's note; another command or real
    // send may have taken over the shared status surface during the request.
    setTimeout(() => {
      if (composerCommandStatusKey === key && statusEl.textContent === msg) {
        composerCommandStatusKey = null;
        setSendStatus("", "");
      }
    }, 3000);
    state.openConvHash = "";
    poll();
  } catch {
    // Invariant: The server may have committed before the connection failed. Do
    // not offer a one-click retry (especially for take-over); refresh
    // authoritative state.
    setComposerCommandStatus(
      key,
      convId,
      `/${name} status unknown`,
      "command-error",
    );
    state.openConvHash = "";
    poll();
  } finally {
    runningComposerCommands.delete(key);
  }
}

// Synchronous admission keeps autocomplete/exact-submit text intact when the
// destructive clear is cancelled or the same command is already in flight.
function startComposerCommand(
  name: string,
  convId: string,
  question?: string,
): boolean {
  if (!composerCommandAvailable(name, convId)) return false;
  if (name === "btw" && !question?.trim()) return false;
  const endpoint = COMPOSER_COMMAND_ENDPOINT[name];
  if (!endpoint) return false;
  const key = `${convId}:${name}`;
  if (runningComposerCommands.has(key)) return false;
  if (
    name === "clear" &&
    !confirm(
      "Delete this history and start fresh?\n\n" +
        "Existing messages and tool details will no longer be shown. Messages currently queued before clear are discarded.",
    )
  )
    return false;
  runningComposerCommands.add(key);
  void runComposerCommand(name, convId, key, question);
  return true;
}

// /revive: the archive finder; a revived agent opens once the tree lists it.
function startRevive(): boolean {
  return openAgentFinderRevive((result) => {
    const key = "revive";
    const text = [
      `Revived ${result.title ?? result.id}.`,
      ...result.notes,
    ].join(" ");
    setComposerCommandStatus(key, state.selectedId, text, "", true);
    setTimeout(() => {
      if (composerCommandStatusKey === key && statusEl.textContent === text) {
        composerCommandStatusKey = null;
        setSendStatus("", "");
      }
    }, 6000);
    void (async () => {
      for (let tries = 0; tries < 20 && !state.nodes[result.id]; tries++) {
        await poll();
        if (!state.nodes[result.id])
          await new Promise((r) => setTimeout(r, 500));
      }
      openFoundAgent(result.id);
    })();
  });
}

setComposerCommandRunner((name) => {
  if (name === "revive") {
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    return startRevive();
  }
  const convId = state.selectedId;
  if (!convId || convId === DRAFT) return false;
  if (name === "btw") {
    inputEl.value = "/btw ";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.focus();
    return true;
  }
  return startComposerCommand(name, convId);
});

export function send(): void {
  if (pendingSavedRecovery) return;
  // Spec: Bare exact platform commands run actions, never model messages.
  // Trailing prose remains a message; drafts without a target use first-send
  // text.
  if (
    !hasStagedAttachments() &&
    matchComposerCommand(inputEl.value)?.name === "revive"
  ) {
    if (startRevive()) clearComposer(currentUiOwnerId());
    return;
  }
  if (!state.draft && !hasStagedAttachments()) {
    const cmd = matchComposerCommand(inputEl.value);
    const convId = state.selectedId;
    if (cmd && convId && convId !== DRAFT) {
      if (!composerCommandAvailable(cmd.name, convId)) {
        // Invariant: Reserved platform syntax never falls through into pi just
        // because the action is unavailable here.
        setSendStatus(`/${cmd.name} unavailable`, "command-error");
      } else if (cmd.name === "btw" && !cmd.question) {
        setSendStatus("/btw needs a question", "command-error");
      } else if (startComposerCommand(cmd.name, convId, cmd.question)) {
        clearComposer(convId);
      }
      // Invariant: A cancelled confirmation / duplicate/unavailable command
      // retains the exact text; it must never become a model prompt instead.
      return;
    }
  }
  const composerOwner = currentUiOwnerId();
  const text = inputEl.value.trim();
  const ready = takeAttachmentsForSend();
  if (ready === null || (!text && !ready.length)) return;
  let content = text;
  for (const a of ready) {
    if (a.isImage) {
      const alt =
        (a.filename || "image").replace(/[\[\]\n]/g, " ").trim() || "image";
      content += `\n\n![${alt}](${a.url})`;
    } else {
      const label =
        (a.filename || "file").replace(/[\[\]]/g, " ").trim() || "file";
      content += `\n\n[${label}](${a.url})`;
    }
  }
  content = content.trim();
  const attachmentIds = ready
    .map((item) => attachmentIdFromUrl(item.url))
    .filter((id): id is string => !!id);
  let job: SendJob;
  if (state.draft) {
    const d = state.draft;
    if (d.creator) {
      // Invariant: Follow-ups await the draft's creator id and use the same
      // agent. Fast repeat sends must not spawn a second conversation.
      job = {
        draft: false,
        convId: d.creator.convId,
        waitFor: d.creator,
        content,
        attachmentIds,
        clientId: newClientMessageId(),
        retry: 0,
        timer: 0,
        inFlight: false,
        failed: false,
      };
    } else {
      // Invariant: First send creates once, then delivers. Files added
      // meanwhile await the saved owner rather than racing the transferring
      // draft lease.
      const { convIdReady, resolveConvId } = conversationIdLease(null);
      job = {
        draft: true,
        parent: d.parent,
        backendLabel: d.backendLabel,
        model: d.model,
        effort: d.effort,
        level: d.level,
        attachmentDraft: d.attachmentDraft,
        muted: d.muted,
        convIdReady,
        resolveConvId,
        convId: null,
        content,
        attachmentIds,
        clientId: newClientMessageId(),
        retry: 0,
        timer: 0,
        inFlight: false,
        failed: false,
      };
      d.creator = job;
    }
    jobs.push(job);
    (d.pending = d.pending || []).push({ role: "user", content });
    clearComposer(composerOwner);
    renderDraft();
  } else {
    job = {
      draft: false,
      convId: state.selectedId,
      content,
      attachmentIds,
      clientId: newClientMessageId(),
      retry: 0,
      timer: 0,
      inFlight: false,
      failed: false,
    };
    jobs.push(job);
    clearComposer(composerOwner);
  }
  runJob(job);
  renderSendStatus();
}

// One job's resilient attempt: (create the agent, drafts only) + deliver the
// message. Guards on job.inFlight so a backoff timer and the "online" event
// can't double-fire the same job; stores job.convId after create so a retry
// never spawns a second agent.
async function runJob(job: SendJob): Promise<void> {
  if (job.inFlight) return;
  job.inFlight = true;
  let r: Response | undefined,
    failed = false;
  try {
    // Invariant: Only an unbound boot-time job adopts the first selection;
    // retries of bound jobs never follow later navigation.
    if (!job.draft && !job.convId && !job.waitFor) {
      job.waitingForSelection = true;
      renderSendStatus();
      await waitForInitialAuthoritativeRead();
      job.waitingForSelection = false;
      const target = state.selectedId;
      if (!target || target === DRAFT) {
        job.inFlight = false;
        job.failed = true;
        job.error = "Choose an agent before sending. — Retry now";
        renderSendStatus();
        return;
      }
      job.convId = target;
      renderSendStatus();
    }
    if (job.draft && !job.convId) {
      const backend = backendFor(
        job.backendLabel
          ? conversationId(job.backendLabel, DRAFT)
          : job.parent || "",
      );
      const body = conversationCreationBody({
        ...job,
        parent: job.parent ? parseConversationId(job.parent).cid : job.parent,
        attachmentDraft: job.attachmentDraft
          ? parseConversationId(job.attachmentDraft).cid
          : job.attachmentDraft,
      });
      // Invariant: Creating an agent is not idempotent. Browser/network failure
      // and 5xx still feed health, but no client timer may abort a request that
      // the server could commit before our retry creates a duplicate.
      const cr = await backend.jpost("/api/conversations", body, {
        availability: "core",
        timeoutMs: 0,
      });
      if (cr.status === 401) {
        job.inFlight = false;
        job.failed = true;
        job.error = "Session expired — message kept. Log in to continue.";
        renderSendStatus();
        return;
      }
      if (!cr.ok) {
        if (cr.status >= 400 && cr.status < 500) {
          let detail = "Couldn't create this agent.";
          try {
            detail =
              ((await cr.json()) as { detail?: string }).detail || detail;
          } catch {}
          job.inFlight = false;
          job.failed = true;
          job.error = `${detail} — Retry now`;
          renderSendStatus();
          return;
        }
        throw new Error("create failed");
      }
      job.convId = conversationId(
        backend.label,
        ((await cr.json()) as { id: string }).id,
      );
      treeOf(backend).noteCreation(parseConversationId(job.convId).cid);
      job.resolveConvId?.(job.convId);
    } else if (job.waitFor && !job.convId) {
      // Invariant: Followers await their creator without consuming network
      // retries. If creation gives up, followers give up too; otherwise they
      // wait locally.
      if (job.waitFor.failed) {
        job.inFlight = false;
        job.failed = true;
        renderSendStatus();
        return;
      }
      if (!job.waitFor.convId) {
        job.inFlight = false;
        job.timer = setTimeout(() => runJob(job), 300) as unknown as number;
        return;
      }
      job.convId = job.waitFor.convId;
    }
    // Invariant: Polling may show delivery before this request returns; keep
    // the pre-send floor.
    job.sinceOffset ??= job.convId ? newestCommittedOffset(job.convId) : 0;
    // Invariant: Every retry reuses the job id, safely replaying an admitted
    // ack. Network errors/5xx retain retries; permanent validation errors stay
    // failed. No client timer aborts ambiguous commits.
    r = await backendFor(job.convId || "").jpost(
      `/api/conversations/${job.convId}/deliver`,
      {
        content: job.content,
        client_message_id: job.clientId,
        ...(job.attachmentIds.length
          ? { attachment_ids: job.attachmentIds }
          : {}),
      },
      { availability: "core", timeoutMs: 0 },
    );
  } catch {
    failed = true;
  }
  job.inFlight = false;
  if (r && r.status === 401) {
    job.failed = true;
    job.error = "Session expired — message kept. Log in to continue.";
    renderSendStatus();
    return;
  }
  if (r?.status === 404) {
    job.failed = true;
    job.error = "This agent is no longer available. — Retry now";
    renderSendStatus();
    return;
  }
  if (
    r?.status === 422 ||
    (parseConversationId(job.convId || "").label &&
      (r?.status === 424 || r?.status === 502))
  ) {
    let detail = "This message could not be accepted.";
    try {
      const body = (await r.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {}
    job.failed = true;
    job.error = `${detail} — Retry now`;
    renderSendStatus();
    return;
  }
  if (!failed && r && r.ok) {
    try {
      const result = (await r.json()) as {
        message_id?: unknown;
        steer?: unknown;
      };
      if (typeof result.message_id === "string")
        job.messageId = result.message_id;
      job.steered = result.steer === true;
      if (job.steered && job.convId) requestUiRefresh(job.convId);
    } catch {}
    jobSucceeded(job);
    return;
  }
  job.retry++;
  if (job.retry >= MAX_ATTEMPTS) {
    job.failed = true;
    renderSendStatus();
    return;
  }
  const delay = Math.min(30000, 1000 * 2 ** (job.retry - 1));
  job.timer = setTimeout(() => runJob(job), delay) as unknown as number;
  renderSendStatus();
}

function jobSucceeded(job: SendJob): void {
  clearTimeout(job.timer);
  jobs = jobs.filter((j) => j !== job);
  if (!job.draft && job.convId) clearStopForNewTurn(job.convId);
  if (!job.draft && job.convId && job.convId === state.selectedId)
    addOptimisticPending(
      job.convId,
      job.content,
      job.sinceOffset ?? 0,
      job.messageId,
    );
  // Invariant: Promote only the draft still on screen, preserving its thread.
  // After navigation, the created agent appears through polling, never steals
  // view.
  if (
    job.draft &&
    job.convId &&
    state.selectedId === DRAFT &&
    state.draft &&
    state.draft.creator === job
  ) {
    adoptDraftSkills(job.convId);
    selectAgent(job.convId, true, true);
  }
  state.openConvHash = "";
  poll();
  renderSendStatus();
}

window.addEventListener("online", () => {
  // Invariant: connection.ts updates health in synchronous online listeners.
  // Retry/send status runs afterward, so it reads the new connection state.
  queueMicrotask(() => {
    for (const j of jobs)
      if (!j.failed && !j.inFlight) {
        clearTimeout(j.timer);
        j.retry = 0;
        runJob(j);
      }
    renderSendStatus();
  });
});
window.addEventListener("offline", () => renderSendStatus());

// Instant + client-side: show a blank thread and focus the box right away.
// The agent is created on the server only when the first message is sent.
export function startDraft(spec: DraftSpec): void {
  if (sharedTrees !== null && (!spec.parent || !state.nodes[spec.parent]))
    return;
  // Invariant: A draft has no panes of its own. Guard before changing selection
  // so staged Artifacts/Changes comments stay visible when the operator
  // cancels.
  if (!guardLeaveComments()) return;
  const outgoingOwner = currentUiOwnerId();
  snapshotComposerOwner(outgoingOwner);
  const outgoing = state.selectedId;
  const uiStateId = newDraftUiOwnerId();
  state.draft = {
    ...spec,
    ...snapshotNewSubagentDefaults(),
    uiStateId,
  };
  state.selectedId = DRAFT;
  state.cursorId = DRAFT;
  state.openConvHash = "";
  preloadSkills();
  // Invariant: A new draft never inherits a saved agent or replaced draft's
  // text. The latter is unreachable after replacement, so drop its ephemeral
  // record.
  switchComposerOwner(uiStateId, outgoing === DRAFT);
  renderDraft();
  renderSidebar();
  closeMobileSidebar(true);
  // Invariant: A draft is its own history entry, addressed by the parent it
  // will be created under, so Back closes it and lands on that parent.
  syncHistoryToSelection();
  refreshUpBtn();
  inputEl.focus();
}
const newTop = $<HTMLButtonElement>("#new-top")!;
newTop.hidden = sharedTrees !== null;
newTop.onclick = () => startDraft({ parent: null });

sendEl.onclick = (event: MouseEvent) => {
  // Invariant: A long-press only peeked at the tip; it must neither send nor
  // arm.
  if (consumeComposerStopHold()) return;
  const intent = activateComposerControl();
  if (intent === "send") send();
  else if (intent === "prepare-stop") {
    const generation = activeComposerStopPreparation();
    if (generation !== null)
      void prepareStopTarget().then((target) =>
        armPreparedComposerStop(target, generation),
      );
  } else if (intent === "stop")
    void requestStop(event.detail === 0 ? "keyboard" : "click");
};

// ---------------- composer sizing
export function autosize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
}
inputEl.addEventListener("input", () => {
  // Invariant: Any edit cancels a pending Stop confirmation. Clearing the text
  // after typing can return the control to Stop, but never to an already-hot
  // Stop.
  disarmComposerStop();
  // Invariant: Input events (including IME composition updates) only snapshot
  // the active owner; they never trigger restoration or synchronous browser
  // storage.
  noteComposerInput(activeComposerOwnerId());
  autosize();
  refreshAttachmentSendState();
  refreshSkillAutocomplete();
});
inputEl.addEventListener("select", () =>
  noteComposerInput(activeComposerOwnerId()),
);

function refreshRestoredComposer(): void {
  closeComposerAutocomplete();
  autosize();
  refreshAttachmentSendState();
}
document.addEventListener(
  "recurse:composer-state-restored",
  refreshRestoredComposer,
);
window.addEventListener("recurse:tree-authoritative", () => {
  const validOwners = new Set(Object.keys(state.nodes));
  for (const ownerId of pendingRecoveredAttachmentOwners)
    if (!validOwners.has(ownerId)) conversationUiState.remove(ownerId);
  pendingRecoveredAttachmentOwners = [];
  const recovery = pendingSavedRecovery;
  if (!recovery) return;
  const target = resolveAuthRecoveryOwner(
    recovery.owner,
    new Set(Object.keys(state.nodes)),
    state.selectedId,
  );
  // Invariant: The textarea stays editable while the first tree loads. Preserve
  // what is live now—not merely the login snapshot—so early typing/caret
  // changes cannot be erased at owner validation.
  const recoveredInput = inputEl.value;
  const recoveredStart = inputEl.selectionStart ?? recoveredInput.length;
  const recoveredEnd = inputEl.selectionEnd ?? recoveredInput.length;
  // Invariant: Recovery skips the tree-selected owner's outgoing snapshot.
  // Unrelated text stays untouched; restoring work corrects current history
  // instead of adding a view the reader never chose.
  if (target !== state.selectedId)
    asHistoryCorrection(() => selectAgent(target, false, true, true));
  else switchComposerOwner(target, true);
  if (recovery.owner && target !== recovery.owner)
    abandonStagedAttachments(recovery.uiStateId);
  else transferStagedAttachmentOwner(recovery.uiStateId, target);
  conversationUiState.remove(recovery.uiStateId);
  pendingSavedRecovery = null;
  setAttachmentInputBlocked(false);
  restoreComposerValue(target, {
    text: recoveredInput,
    selectionStart: recoveredStart,
    selectionEnd: recoveredEnd,
  });
  refreshRestoredComposer();
});
addEventListener("pagehide", () => {
  const ownerId = activeComposerOwnerId();
  snapshotComposerOwner(ownerId);
  conversationUiState.flush(ownerId);
});
restoreAfterLogin();
refreshRestoredComposer();
