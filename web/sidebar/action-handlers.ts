// App startup connects sidebar actions to their tree, draft and dialog owners.
import type { TemplateResult } from "lit";
import type { TreeNode } from "../types.js";

type StartDraft = (backendLabel?: string, tags?: string[]) => void;
type ActiveAgentRow = (
  node: TreeNode,
  depth: number,
  open: (event: Event, id: string) => void,
) => TemplateResult;

export let refreshSidebarTree: () => Promise<void>;
export let startDraft: StartDraft;
export let renderActiveAgentRow: ActiveAgentRow;
export let openAgent: (id: string) => void;

export function configureSidebarActions(actions: {
  refreshTree: typeof refreshSidebarTree;
  startDraft: StartDraft;
  renderActiveAgentRow: ActiveAgentRow;
  openAgent: typeof openAgent;
}): void {
  ({
    refreshTree: refreshSidebarTree,
    startDraft,
    renderActiveAgentRow,
    openAgent,
  } = actions);
}
