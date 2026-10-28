// Pure policy for opening the Artifacts pane. Artifact polling stays in
// report.ts; panes.ts supplies the current UI guards and applies this helper's
// edge-triggered decision. Attention survives navigation in one record per live
// conversation; first phone discovery baselines existing artifacts silently.

export type ArtifactGeneration = string | null | undefined;
export type AutoOpenAnnouncement = "opened" | "available" | null;

export interface ArtifactAutoOpenObservation {
  agentId: string;
  // undefined: loading/error/unknown; null: known empty; string: known nonempty
  generation: ArtifactGeneration;
  artifactsPaneOpen: boolean;
  otherPaneOpen: boolean;
  typing: boolean;
  modalOpen: boolean;
  unsentComments: boolean;
  mobileKeyboardOpen: boolean;
  // Phone panes require explicit opening; discovery never covers conversation.
  mobile: boolean;
}

export interface ArtifactAutoOpenDecision {
  open: boolean;
  badged: boolean;
  announcement: AutoOpenAnnouncement;
  // Desktop defaults preserve focus; phone modal integration focuses inside.
  focusHeading: false;
}

const decision = (
  open: boolean,
  badged: boolean,
  announcement: AutoOpenAnnouncement = null,
): ArtifactAutoOpenDecision => ({
  open,
  badged,
  announcement,
  focusHeading: false,
});

export function artifactGeneration(
  artifacts: readonly {
    id: string;
    version: string | null;
    updated_at: string;
  }[],
): string | null {
  if (!artifacts.length) return null;
  return JSON.stringify(
    artifacts
      .map((item) => [item.id, item.version || item.updated_at] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export class ArtifactPaneAutoOpenPolicy {
  private agentId: string | null = null;
  private generation: string | null = null;
  private generationKnown = false;
  private handled = false;
  private badged = false;
  private deliberatePaneChoice = false;
  private readonly visits = new Map<
    string,
    {
      generation: string | null;
      generationKnown: boolean;
      handled: boolean;
      badged: boolean;
    }
  >();

  constructor(private readonly trackSeenGenerations = false) {}

  retainAgents(agentIds: ReadonlySet<string>): void {
    for (const id of this.visits.keys())
      if (!agentIds.has(id)) this.visits.delete(id);
    if (this.agentId && !agentIds.has(this.agentId)) this.agentId = null;
  }

  beginVisit(agentId: string): void {
    if (this.agentId === agentId) return;
    if (this.trackSeenGenerations && this.agentId)
      this.visits.set(this.agentId, {
        generation: this.generation,
        generationKnown: this.generationKnown,
        handled: this.handled,
        badged: this.badged,
      });
    const prior = this.visits.get(agentId);
    this.agentId = agentId;
    this.generation = prior?.generation ?? null;
    this.generationKnown = prior?.generationKnown ?? false;
    this.handled = prior?.handled ?? false;
    this.badged = prior?.badged ?? false;
    this.deliberatePaneChoice = false;
  }

  noteArtifactsOpened(agentId: string): void {
    if (agentId !== this.agentId) return;
    this.badged = false;
    if (this.generationKnown && this.generation !== null) this.handled = true;
  }

  noteUserPaneChoice(agentId: string): void {
    if (agentId !== this.agentId) return;
    this.deliberatePaneChoice = true;
    if (this.trackSeenGenerations) return;
    this.badged = false;
    if (this.generationKnown && this.generation !== null) this.handled = true;
  }

  observe(input: ArtifactAutoOpenObservation): ArtifactAutoOpenDecision {
    if (this.agentId === null) this.beginVisit(input.agentId);
    // Invariant: An old request can finish after navigation. It may populate
    // its own cache, but it must never affect the newly selected conversation's
    // pane state.
    if (input.agentId !== this.agentId) return decision(false, false);

    if (input.generation === undefined) return decision(false, this.badged);
    if (input.generation === null) {
      this.generation = null;
      this.generationKnown = true;
      this.handled = false;
      this.badged = false;
      return decision(false, false);
    }

    const baseline =
      this.trackSeenGenerations && input.mobile && !this.generationKnown;
    const changed =
      !this.generationKnown || input.generation !== this.generation;
    if (changed) {
      this.generation = input.generation;
      this.generationKnown = true;
      this.handled = baseline;
      this.badged = false;
    }

    if (input.artifactsPaneOpen) {
      this.handled = true;
      this.badged = false;
      return decision(false, false);
    }
    if (this.handled) return decision(false, this.badged);

    if (this.deliberatePaneChoice || input.otherPaneOpen) {
      const announce = !this.badged ? "available" : null;
      this.badged = true;
      return decision(false, true, announce);
    }

    // Invariant: On a phone, opening a pane covers the entire conversation.
    // Keep Artifacts discoverable through the panel button without replacing
    // the operator's view. An explicit open calls noteArtifactsOpened() and
    // consumes this generation.
    if (input.mobile) {
      const announce = !this.badged ? "available" : null;
      this.badged = true;
      return decision(false, true, announce);
    }

    const blocked =
      input.typing ||
      input.modalOpen ||
      input.unsentComments ||
      input.mobileKeyboardOpen;
    if (blocked) {
      const announce = !this.badged ? "available" : null;
      this.badged = true;
      return decision(false, true, announce);
    }

    // Invariant: A transiently blocked desktop generation remains eligible once
    // its guard clears; every other generation is consumed on this edge and
    // never reopens.
    this.handled = true;
    this.badged = false;
    return decision(true, false, "opened");
  }
}
