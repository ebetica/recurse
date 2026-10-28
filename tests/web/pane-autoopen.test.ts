import { describe, expect, test } from "bun:test";
import {
  ArtifactPaneAutoOpenPolicy,
  type ArtifactAutoOpenObservation,
} from "../../web/panes/autoopen.js";

const GEN_A = '[["artifact-a","' + "a".repeat(40) + '"]]';
const GEN_B = '[["artifact-a","' + "b".repeat(40) + '"]]';

const observation = (
  agentId: string,
  generation: string | null | undefined,
  overrides: Partial<ArtifactAutoOpenObservation> = {},
): ArtifactAutoOpenObservation => ({
  agentId,
  generation,
  artifactsPaneOpen: false,
  otherPaneOpen: false,
  typing: false,
  modalOpen: false,
  unsentComments: false,
  mobileKeyboardOpen: false,
  mobile: false,
  ...overrides,
});

function fresh(agentId = "agent-a"): ArtifactPaneAutoOpenPolicy {
  const policy = new ArtifactPaneAutoOpenPolicy(true);
  policy.beginVisit(agentId);
  return policy;
}

describe("Artifacts pane auto-open policy", () => {
  test("consumed artifacts stay consumed across conversation visits", () => {
    const policy = fresh("restored");
    expect(policy.observe(observation("restored", GEN_A)).open).toBe(true);
    policy.beginVisit("other");
    expect(policy.observe(observation("other", null)).open).toBe(false);
    policy.beginVisit("restored");
    expect(policy.observe(observation("restored", GEN_A)).open).toBe(false);
    expect(policy.observe(observation("restored", GEN_B)).open).toBe(true);
    policy.beginVisit("other");
    policy.retainAgents(new Set(["other"]));
    policy.beginVisit("restored");
    expect(policy.observe(observation("restored", GEN_A)).open).toBe(true);
  });

  test("an unread phone version stays unread across restored pane choices", () => {
    const policy = fresh();
    policy.observe(observation("agent-a", GEN_A, { mobile: true }));
    expect(
      policy.observe(observation("agent-a", GEN_B, { mobile: true })).badged,
    ).toBe(true);
    policy.beginVisit("agent-b");
    policy.beginVisit("agent-a");
    policy.noteUserPaneChoice("agent-a");
    expect(
      policy.observe(observation("agent-a", GEN_B, { mobile: true })).badged,
    ).toBe(true);
    policy.noteArtifactsOpened("agent-a");
    expect(
      policy.observe(observation("agent-a", GEN_B, { mobile: true })).badged,
    ).toBe(false);
  });

  test("a phone baselines existing artifacts without an unread notification", () => {
    const policy = fresh();
    expect(
      policy.observe(
        observation("agent-a", GEN_A, {
          mobile: true,
          mobileKeyboardOpen: true,
        }),
      ),
    ).toMatchObject({ open: false, badged: false, announcement: null });
    expect(
      policy.observe(observation("agent-a", GEN_A, { mobile: true })),
    ).toMatchObject({ open: false, badged: false, announcement: null });
    expect(
      policy.observe(observation("agent-a", GEN_B, { mobile: true })),
    ).toMatchObject({ open: false, badged: true });
  });
});
