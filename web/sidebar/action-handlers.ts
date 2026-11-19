// App startup supplies effects without coupling the sidebar to app features.
type StartDraft = (backendLabel?: string, tags?: string[]) => void;

export let refreshSidebarTags: () => Promise<void>;
export let startDraft: StartDraft;

export function configureSidebarActions({
  refreshTags,
  startDraft: openDraft,
}: {
  refreshTags: () => Promise<void>;
  startDraft: StartDraft;
}): void {
  refreshSidebarTags = refreshTags;
  startDraft = openDraft;
}
