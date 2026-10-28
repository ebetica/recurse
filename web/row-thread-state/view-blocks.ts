// Immutable ConversationView rows and bounded windows served by /view.
import type { CodemodeCall } from "../thread-render/turn-view.js";
import type {
  AgentAttachment,
  ModelResponse,
  ToolStat,
  TurnUsage,
  TurnSummary,
} from "../types.js";

export interface ViewBlock {
  id: string;
  order?: number;
  offset?: number;
  kind: string;
  role: string;
  text: string;
  thinking_title?: string | null;
  has_thinking?: boolean;
  thinking_elapsed_ms?: number;
  live_thinking?: boolean;
  origin: string;
  name: string | null;
  args: string;
  result: string | null;
  result_truncated: boolean;
  live: boolean;
  error?: string | null;
  error_detail?: string | null;
  stop_reason?: string | null;
  running?: boolean;
  tool_elapsed_ms?: number;
  tool_received_at_ms?: number;
  tool_output_tail?: string;
  input?: string | null;
  usage?: TurnUsage | UsageRow | null;
  meta?: ShellRowState | ShellNoticeState | null;
  safety_usage?: TurnSummary["safety_usage"] | null;
  timing?: {
    total_ms?: number;
    safety_ms?: number;
    command_ms?: number;
  } | null;
  model_time_ms?: number | null;
  model_response?: ModelResponse;
  sender?: string | null;
  sender_name?: string | null;
  stat?: ToolStat | null;
  attachment?: AgentAttachment | null;
  /** Files a bash call published with the publish CLI. */
  files?: AgentAttachment[];
  pr_links?: TurnSummary["pr_links"];
  calls?: CodemodeCall[] | null;
}

export interface ViewPage {
  status: string;
  instance_id: string;
  revision: number;
  // Session rotates on Clear/reseed, not view rebuild or compaction.
  session?: string;
  retry_notice?: string | null;
  turn_status?: string;
  active_run?: string | null;
  blocks: unknown;
  older?: boolean;
  newer?: boolean;
  removed?: string[];
  reset?: boolean;
}

export interface UsageRow {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: { total: number };
  model?: string;
  partial: boolean;
  stopReason: string;
  at: number;
  costScope?: string;
  costSource?: "authoritative" | "unknown";
  costScopePartial?: boolean;
  // Steered-segment baseline makes cost an additive delta, not replacement.
  costScopeBase?: number;
}

export interface ShellRowState {
  shellId: string;
  command: string;
  pid: number | null;
  pgid: number | null;
  logPath: string;
  startedAt: number;
}

export interface ShellNoticeState {
  body: string;
}
