import type { BrowserTest } from "./common";
import { browserArguments, runBrowserGroups } from "./parallel";
import { tests as remoteSidebar } from "./test_remote_sidebar";
import { tests as sidebar } from "./test_sidebar";
import { tests as themes } from "./test_themes";
import { tests as layoutWait } from "./test_layout_wait";
import { tests as changes } from "./test_changes_expand";
import { tests as header } from "./test_header";
import { tests as interactionTiming } from "./test_interaction_timing";
import { tests as activeAgents } from "./test_active_agents";
import { tests as paneChrome } from "./test_pane_chrome";
import { tests as paneHotkeys } from "./test_pane_hotkeys";
import { tests as panePowerbar } from "./test_pane_powerbar";
import { tests as commentRefresh } from "./test_comment_refresh";
import { tests as changesCommentBar } from "./test_changes_comment_bar";
import { tests as prDiff } from "./test_pr_diff";
import { tests as prReferences } from "./test_pr_references";
import { tests as compact } from "./test_compact_rows";
import { tests as failed } from "./test_failed_send_hold";
import { tests as hold } from "./test_hold_confirm";
import { tests as recovery } from "./test_recovery";
import { tests as wake } from "./test_wake";
import { tests as settings } from "./test_settings";
import { tests as remotes } from "./test_remotes";
import { tests as settingsSync } from "./test_settings_sync";
import { tests as mcpSettings } from "./test_mcp_settings";
import { tests as composer } from "./test_composer";
import { tests as safety } from "./test_safety";
import { tests as newAgentFocus } from "./test_new_agent_focus";
import { tests as conversationTitle } from "./test_conversation_title";
import { tests as mobileLayout } from "./test_mobile_layout";
import { tests as panesArtifacts } from "./test_panes_artifacts";
import { tests as panesFiles } from "./test_panes_files";
import { tests as visibleAttachments } from "./test_visible_attachments";
import { tests as lineComments } from "./test_line_comments";
import { tests as selectionComments } from "./test_selection_comments";
import { tests as longSelection } from "./test_long_selection";
import { tests as platformCommands } from "./test_platform_commands";
import { tests as sideHistory } from "./test_side_history";
import { tests as waitingTakeover } from "./test_waiting_takeover";
import { tests as steers } from "./test_steers";
import { tests as turns } from "./test_turns";
import { tests as thread } from "./test_thread";
import { tests as threadFocus } from "./test_thread_focus";
import { tests as messageMarkdown } from "./test_message_markdown";
import { tests as imageDrawing } from "./test_image_drawing";
import { tests as imageBoxCrops } from "./test_image_box_crops";
import { tests as modelResponse } from "./test_model_response";
import { tests as providerReplay } from "./test_provider_replay";
import { tests as imageSwipe } from "./test_image_swipe";
import { tests as threadEdges } from "./test_thread_edges";
import { tests as durable } from "./test_durable";
import { tests as liveTools } from "./test_live_tools";
import { tests as artifactCheck } from "./test_artifact_check";

export const groups: Array<[string, BrowserTest[]]> = [
  ["sidebar", sidebar],
  ["remote-sidebar", remoteSidebar],
  ["themes", themes],
  ["layout-wait", layoutWait],
  ["interaction-timing", interactionTiming],
  ["header", header],
  ["active-agents", activeAgents],
  ["pane-chrome", paneChrome],
  ["pane-hotkeys", paneHotkeys],
  ["pane-powerbar", panePowerbar],
  ["changes-expand", changes],
  ["comment-refresh", commentRefresh],
  ["changes-comment-bar", changesCommentBar],
  ["pr-diff", prDiff],
  ["pr-references", prReferences],
  ["compact-rows", compact],
  ["failed-send-hold", failed],
  ["hold-confirm", hold],
  ["recovery", recovery],
  ["wake", wake],
  ["settings", settings],
  ["remotes", remotes],
  ["settings-sync", settingsSync],
  ["mcp-settings", mcpSettings],
  ["composer", composer],
  ["safety", safety],
  ["new-agent-focus", newAgentFocus],
  ["conversation-title", conversationTitle],
  ["mobile-layout", mobileLayout],
  ["panes-artifacts", panesArtifacts],
  ["panes-files", panesFiles],
  ["visible-attachments", visibleAttachments],
  ["line-comments", lineComments],
  ["selection-comments", [...selectionComments, ...longSelection]],
  ["platform-commands", [...platformCommands, ...sideHistory]],
  ["waiting-takeover", waitingTakeover],
  ["steers", steers],
  ["turns", turns],
  ["thread", thread],
  ["thread-focus", threadFocus],
  ["message-markdown", messageMarkdown],
  ["image-drawing", imageDrawing],
  ["image-box-crops", imageBoxCrops],
  ["image-swipe", imageSwipe],
  ["thread-edges", threadEdges],
  ["durable", durable],
  ["model-response", modelResponse],
  ["provider-replay", providerReplay],
  ["live-tools", liveTools],
  ["artifact-check", artifactCheck],
];
if (import.meta.main) {
  const { workers, names } = browserArguments(process.argv.slice(2));
  const unknown = names.filter(
    (name) => !groups.some(([label]) => label === name),
  );
  if (unknown.length)
    throw Error(`unknown browser groups: ${unknown.join(", ")}`);
  await runBrowserGroups(
    names.length ? groups.filter(([label]) => names.includes(label)) : groups,
    workers,
    import.meta.filename,
  );
}
