// Backend wire shapes for tree, /view and authenticated conversation routes.
// Full tool data stays owner-scoped; tree/quick summaries remain redacted.
// Activity counts use closed labels, never paths, commands or raw arguments.
// Pane selection defaults to session privacy; local ids must be non-sensitive.

export type AgentStatus =
  | "idle"
  | "running"
  | "interrupting"
  | "error"
  | "interrupted"
  | "deleting";
export type AgentTreeStatus = AgentStatus | "working" | "waiting" | "unknown";

export interface TreeNode {
  id: string;
  parent: string | null;
  title: string;
  // selected model when the server includes it
  model?: string | null;
  // Canonical tree status; unknown safely covers legacy values.
  status: AgentTreeStatus;
  // epoch seconds
  updated: number;
  // Opaque owner Artifact mutation stamp, independent of turn state.
  artifacts_revision?: string | null;
  operator_message_at?: number | null;
  // subagent count
  children: number;
  // messages waiting to be delivered
  queued: number;
  preview: string;
  // automatic reports to the parent are suppressed
  muted: boolean;
  // agents cannot delete this conversation
  pinned?: boolean;
  // Restart-interrupted; active parked work may resume automatically.
  restart_parked?: boolean;
  // Desired review-off state, applies next turn.
  safety_off?: boolean;
  // Effective launched review-off state for the in-flight turn.
  safety_off_active?: boolean;
  // Opaque instance/workdir/config partition for persisted skills.
  skill_context?: string | null;
  // The parent of a side conversation, which the tree never shows.
  side_of?: string;
  // A side conversation being promoted to a subagent of its parent.
  promoting?: boolean;
  // Why the side conversation's last promotion failed.
  promotion_error?: string;
}

export interface AgentAttachment {
  // opaque owner-scoped id; absent in copied context
  id?: string;
  name: string;
  size: number;
  media_type: string;
  inline_media_type?:
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp"
    | null;
  unavailable?: "copied" | "missing";
}

export interface Message {
  // Marker is platform context summarization/reset, never authored input.
  role: "user" | "assistant" | "marker";
  content: string;
  // latest bounded bold heading
  thinking_title?: string | null;
  /** Internal normalized title used by activity projection. */
  thinking?: string | null;
  // provider sent non-redacted thinking
  has_thinking?: boolean;
  // Platform action recorded by this marker.
  marker?: "compact" | "clear" | string;
  id?: string;
  // epoch seconds this message entered the thread
  ts?: number;
  // sender agent id when the message isn't from the human
  from?: string | null;
  // delivered sender name, retained after deletion
  from_name?: string;
  // trusted ingress source when the backend exposes it
  source?: string | null;
  // trusted authenticated provenance, when present
  origin?: string | null;
  // count of tool uses in an assistant turn
  tools?: number;
  // compact calls + opaque lazy-detail ids
  tool_calls?: ToolCall[];
  // this turn was interrupted (context preserved)
  stopped?: boolean;
  // a user message injected mid-turn to steer the live run
  steer?: boolean;
  // Accepted receipt or live row awaiting transcript settlement.
  delivery_state?: "accepted" | "materialized";
  // adjacent steer rows sharing one Pi/model boundary
  steer_batch_id?: string;
  // zero-based position within that shared boundary
  steer_batch_index?: number;
  // bounded number of rows in that shared boundary
  steer_batch_size?: number;
  error?: string | null;
  // Raw failed-send Pi text for inspection.
  error_detail?: string | null;
  // Failed model requests merged into this reply, when more than one.
  error_attempts?: number;
  // A refused reply: the turn's operator text, left out of later requests.
  refused_text?: string;
  // Precommit send failure retains retry/cancel, never auto-resends.
  uncertain?: boolean;
  // Safety/extension notices explaining blocked actions.
  notices?: string[] | null;
  // Files explicitly registered by this agent for this reply.
  attachments?: AgentAttachment[];
  // durable operator-upload references for Files
  attachment_ids?: string[];
  // Pi's provider-reported aggregate for this finished reply
  usage?: TurnUsage;
  // Latest successful call's point-in-time prompt/context volume.
  latest_usage?: TurnUsage;
  model_responses?: ModelResponse[];
  /** Persisted Pi request-to-assistant-response duration in milliseconds. */
  model_time_ms?: number;
  /** Set while this assistant row's thinking is still streaming. */
  live_thinking?: boolean;
  /** Server-relative elapsed thinking time for a live request. */
  thinking_elapsed_ms?: number;
}

export interface TurnSummary {
  tools: number;
  shell: number;
  read_files: number;
  edit_files: number;
  added: number;
  removed: number;
  write_files: number;
  agents: number;
  // Outgoing subagent send calls; absent on older summaries.
  agent_messages?: number;
  /** subagent rm calls; absent on older stored summaries. */
  agent_reaps?: number;
  searches: number;
  web: number;
  /** Bg-shell completions folded into this response; frontend-counted. */
  background_shells?: number;
  prs: number[];
  /** Canonical URLs captured when a PR was created or merged. */
  pr_links?: Array<{ number: number; url: string }>;
  truncated: boolean;
  approx?: boolean;
  // Recorded turn aggregate only, never a per-answer total.
  usage?: TurnUsageTotal | null;
  // Reviewer billing is recorded independently from the conversation model.
  safety_usage?: SafetyReviewUsageTotal | null;
}

export interface ConversationModelUsageGroup extends TurnUsage {
  selector: string;
  calls: number;
  costPartial: boolean;
}

export interface TurnUsageTotal extends TurnUsage {
  calls: number;
  replies: number;
  partial: boolean;
  model_groups?: ConversationModelUsageGroup[];
  model_usage_partial?: boolean;
}

export interface SafetyReviewUsageGroup extends TurnUsage {
  selector: string;
  cost?: number;
  // Absent before unavailable reviewer prices were representable.
  costPartial?: boolean;
  calls: number;
}

export interface SafetyReviewUsageTotal {
  groups: SafetyReviewUsageGroup[];
  calls: number;
  partial: boolean;
}

export interface ToolStat {
  kind: "read" | "edit" | "write" | "shell" | "search" | "web" | "other";
  lines?: number;
  from?: number;
  to?: number;
  added?: number;
  removed?: number;
  action?:
    | "subagent_create"
    | "subagent_send"
    | "subagent_rm"
    | "worktree_enter"
    | "cron_create"
    | "pr_create"
    | "pr_merge";
}

export interface ToolEntry {
  kind: "tool";
  calls?:
    | {
        name: string;
        stat?: ToolStat;
        omitted?: number;
        summary?: { name: string; stat: ToolStat; count: number }[];
      }[]
    | null;
  count?: number;
  // byte offset of the stored line
  offset: number;
  // 1-based call ordinal within the turn
  seq: number;
  ts?: number;
  name?: string | null;
  // redacted summary, safe on every surface
  input?: string | null;
  // bounded whole shell command, owning conversation only
  input_full?: string;
  // opaque Pi identity shared with the live draft call
  call_id?: string;
  artifact_id?: string;
  artifact_unavailable?: "capture_failed" | "copied" | "quota";
  // Producing model request, independent of tool-series grouping.
  model_time_ms?: number;
  /** Bounded thinking label on the first tool of that model request only. */
  thinking?: string | null;
  /** Producing assistant row, independent of tool-series folding. */
  thinking_entry_id?: string;
  /** Provider sent thinking for this request, even without a title. */
  has_thinking?: boolean;
  /** Set when the request is still receiving thinking deltas. */
  live_thinking?: boolean;
  /** Server-relative elapsed thinking time for a live request. */
  thinking_elapsed_ms?: number;
  timing?: {
    total_ms?: number;
    safety_ms?: number;
    command_ms?: number;
  };
  status: "ok" | "stale" | "truncated";
  running?: boolean;
  /** Provider is still preparing the call, before tool admission. */
  preparing?: boolean;
  stat: ToolStat;
}

export interface MessageEntry extends Message {
  kind: "user" | "assistant" | "system";
  offset: number;
  // a compact marker whose summary text can be fetched
  has_summary?: boolean;
  // shell-notice full text, or a compact marker's notice line
  detail?: string;
}

export type TurnEntry = ToolEntry | MessageEntry;

export interface TurnSegment {
  user: MessageEntry[];
  tools: ToolEntry[];
  assistant: MessageEntry | null;
  summary: TurnSummary | null;
}

export interface Turn {
  turn_id: string;
  // byte offset where this turn begins in the log
  cursor?: number;
  started_at: number | null;
  ended_at: number | null;
  open: boolean;
  status: "open" | "idle" | "interrupted" | "error" | "marker";
  summary: TurnSummary | null;
  segments: TurnSegment[];
  // only the newest entries of an enormous turn
  partial: boolean;
  system?: MessageEntry | null;
}

export interface PromptView {
  system: string;
  naming?: { title: string | null; request: unknown; reply: unknown } | null;
  // Latest captured request; older captures may omit it.
  system_messages?: unknown[] | null;
  capture_status?: "captured" | "pending" | "unavailable";
  backend?: string | null;
  model?: string | null;
}

export interface ModelResponse {
  model?: string;
  provider?: string;
  responseModel?: string;
  thinkingLevel?: string;
  providerThinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: number;
}

export interface TurnPromptView {
  driving: string;
  input_source?: "stored";
  message: string;
  system: string;
  role: "user" | "assistant";
  steering: boolean;
  empty?: boolean;
  usage?: TurnUsage | null;
  model_response?: ModelResponse;
}

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Provider/model selectors and authoritative billed total, when recorded.
  selectors?: string[];
  selectorPartial?: boolean;
  cost?: number;
  /** Provider cost provenance; unknown never means a free request. */
  costSource?: "authoritative" | "unknown";
  /** The aggregate is a lower bound when any price report is unavailable. */
  costPartial?: boolean;
  costScope?: string;
  costScopePartial?: boolean;
}

export interface ToolCall {
  name: string;
  input: string | null;
  input_full?: string;
  // start order within the live run
  seq?: number;
  // completion order, absent while running
  end_seq?: number | null;
  // bounded full input JSON, owning conversation only
  args?: string | null;
  args_truncated?: boolean;
  // bounded full result text, owning conversation only
  result?: string | null;
  result_truncated?: boolean;
  // opaque Pi identity shared with its transcript row
  call_id?: string;
  // transient live-draft call, absent once finished
  active?: boolean;
  // bounded newest partial result, selected conversation only
  output?: string;
  artifact_id?: string;
  artifact_unavailable?: "capture_failed" | "copied" | "quota";
  timing?: {
    total_ms?: number;
    safety_ms?: number;
    command_ms?: number;
  };
}

export interface CapturedPayload {
  format: "json" | "json-head-tail";
  bytes: number;
  omitted_bytes: number;
  value?: unknown;
  stored_bytes?: number;
  head_base64?: string;
  tail_base64?: string;
}

export interface ToolArtifactEvent {
  version: number;
  kind: string;
  timestamp: number;
  is_error?: boolean;
  payload: CapturedPayload;
}

export interface ToolArtifact {
  version: number;
  artifact_id: string;
  message_id: string;
  tool_name: string;
  status: "running" | "finished" | "error" | "stale";
  input_source: "tool_call_hook" | "rpc_start";
  created_at: number;
  updated_at: number;
  finished_at?: number;
  input: ToolArtifactEvent | null;
  latest_update: ToolArtifactEvent | null;
  result: ToolArtifactEvent | null;
  background_latest: ToolArtifactEvent | null;
  update_count: number;
  background_count: number;
  background_active: boolean;
  timing?: {
    total_ms?: number;
    safety_ms?: number;
    command_ms?: number;
  };
  capture: {
    max_record_bytes?: number;
    max_update_bytes?: number;
    max_background_bytes?: number;
    update_omitted_bytes?: number;
    background_omitted_bytes?: number;
  };
  raw_url: string;
}

export interface BackgroundShell {
  // Full selected-owner command; no output or process identity crosses here.
  command: string;
  mode: "foreground" | "background" | "monitor" | null;
  status: "running" | "stopping";
  started_at: number;
  elapsed_seconds: number;
}

export interface BackgroundShellView {
  status: "ready" | "disabled" | "unavailable";
  scope: "selected_agent_current_session";
  agent_id: string;
  agent_title: string;
  items: BackgroundShell[];
  truncated: boolean;
  // uncapped total live records
  active_count: number;
  // uncapped running background/monitor records
  background_count?: number;
}

export interface PendingModel {
  model: string;
  effort?: string;
  level?: number | null;
}

export interface Conversation {
  id: string;
  github_repo_url?: string | null;
  title?: string;
  parent?: string | null;
  muted?: boolean;
  pinned?: boolean;
  // Desired review-off state, applies next turn.
  safety_off?: boolean;
  // Effective launched review-off state for this in-flight turn.
  safety_off_active?: boolean;
  safety_unavailable?: string | null;
  status: AgentStatus;
  // Restart-interrupted; active parked work may resume automatically.
  restart_parked?: boolean;
  msg_count: number;
  // Persisted reasoning effort for the next turn.
  effort?: string;
  // Instance ladder level 1-5, matching stored model and effort.
  level?: number | null;
  /** Composer selection to apply when the next operator message is admitted. */
  pending_model?: PendingModel | null;
  // Unaccepted provider prompt's start time for visible cold-start status.
  provider_starting?: number | null;
  // Unaccepted prompt reused warm core or spawned cold; legacy rows omit it.
  core_reused?: boolean | null;
  pending?: Message[];
  model?: string | null;
  // Finalized call: null fences context; absence permits legacy fallback.
  latest_context_usage?: TurnUsage | null;
  context_usage_estimate?: TurnUsage | null;
  backend?: string | null;
  description?: string | null;
  shells?: BackgroundShellView;
  // a context summarization is running right now
  compacting?: boolean;
  // "compact"/"clear" requested but not applied yet
  pending_actions?: string[];
  // legacy clear reconciliation epoch
  thread_generation?: string;
  // Active physical JSONL generation; advances on compact.
  message_log_generation?: number;
  active_run?: string | null;
  retry_notice?: string | null;
}

export interface DraftCreator {
  convId: string | null;
  failed?: boolean;
  // Uploads added after first send await the saved owner.
  convIdReady?: Promise<string>;
}

export interface Draft {
  parent: string | null;
  backendLabel?: string;
  // ephemeral browser-only owner for this one live draft
  uiStateId?: string;
  model?: string | null;
  effort?: string;
  // effort level 1-5, applied at create time
  level?: number | null;
  // snapshot the browser preference once
  muted?: boolean;
  // First messages sent while creation is still in flight.
  pending?: Message[];
  // the send job minting this agent (set on first send)
  creator?: DraftCreator;
  // Server lease shared by this draft's staged uploads.
  attachmentDraft?: string;
  // One lazy creation shared by concurrent uploads.
  attachmentDraftPromise?: Promise<string>;
}

export interface SkillChoice {
  name: string;
  description: string;
}

export interface ContextTokenEstimate {
  system: number;
  prompts: number;
  messages: number;
  tool_calls: number;
  tool_outputs: number;
}

export interface ContextUsageDetail {
  model: string;
  model_label: string;
  used_tokens: number | null;
  usage_model: string | null;
  context_window: number | null;
  unused_tokens: number | null;
  estimated_tokens: ContextTokenEstimate | null;
}

export interface PaneContext {
  // the open agent's id (or the draft sentinel)
  agentId: string;
  // its tree node, or null
  node: TreeNode | null;
  // Latest conversation or null while draft/unloaded.
  conv: Conversation | null;
  // the whole id -> node map
  nodes: Record<string, TreeNode>;
}

export interface PaneViewStateDef {
  key: string;
  storageSlot: number;
  version: number;
  retention?: "local" | "session";
  defaultValue(): unknown;
  parse(value: unknown): unknown;
  serialize(value: unknown): unknown;
  capture(el: HTMLElement, ctx: PaneContext): unknown;
  restore(el: HTMLElement, ctx: PaneContext, value: unknown): void;
}

export interface PaneCacheDef {
  version: number;
  key(ctx: PaneContext): string | null;
  // Unknown generations refuse rendered-body reuse.
  generation?(ctx: PaneContext): string | null | undefined;
  resume?(el: HTMLElement, ctx: PaneContext): void;
  dispose?(el: HTMLElement, ctx: PaneContext): void;
}

export interface PaneDef {
  id: string;
  title?: string;
  icon?: string;
  available?(ctx: PaneContext): boolean;
  // Content generation: undefined unknown/error, null known empty, else stable.
  autoOpenGeneration?(ctx: PaneContext): string | null | undefined;
  // Called when the reader starts a visit (a conversation, the draft, or none).
  visit?(agentId: string): void;
  // Called just before the policy opens this pane.
  autoOpened?(ctx: PaneContext): void;
  badge?(ctx: PaneContext): string | number | null | undefined;
  viewState?: PaneViewStateDef;
  cache?: PaneCacheDef;
  render?(el: HTMLElement, ctx: PaneContext): void;
  // Poll refresh detects changes to avoid rebuilding steady panes.
  refresh?(el: HTMLElement, ctx: PaneContext): void;
  /** Called just before the open body leaves the page. */
  leave?(el: HTMLElement): void;
}
