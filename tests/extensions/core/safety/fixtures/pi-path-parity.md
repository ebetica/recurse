# Recorded Pi safety parity

pi-path-parity.json contains real outputs from the deleted Pi extension's
createPiSafety hooks, with the real reviewer and faux provider responses. The
Durable cases compare every decision, request and notice exactly; only the
existing random evidence-generation token and test-directory placeholders are
normalized.

durable.test.ts launches the cases with private temporary directories and
stripped CHAT*, RECURSE* and PI\* variables. The fixture passes its trusted values,
config directory, conversation identity and shell roots explicitly to safety.
An unavailable shell view reproduces the recorded "shell registry could not be
read safely" response without inspecting host processes. The parent never
changes its environment and removes the root only after the child exits.

## Re-recording the environment-dependent policy line

The October 2026 refresh used Bun 1.4.2 and the original viaPi function and
createPiSafety implementation from 7e08ec6fd^ (tests/pi-safety/durable.test.ts and
pi-safety/src/). Extract them into agent scratch, resolve dependencies against
the checkout's node_modules, and adjust the recorder's safety imports to those
extracted sources. Replace its root/workspace initialization with TMPDIR and
RECURSE_WORKSPACE_ROOT, respectively. Launch it using the same environment and
directory setup as durable.test.ts, before importing the extracted policy.

Call viaPi for every case name present in the fixture, clearing the reviewer
journal between cases, then record its three-denial breaker case. Fold the
identical reviewer system strings into the top-level system field. Replace the
workspace and data directory with <WORKSPACE> and <DATA_DIR>. Compare the entire
parsed recording with the previous fixture after substituting its old data
path; no decisions, requests, notices or cases may otherwise differ.

The resulting recording matched exactly. The checked-in bytes were preserved
apart from replacing all three occurrences of the instance-specific data path
with <DATA_DIR> (system policy and two inlined retries); all process-snapshot
lines remained unchanged. Cases removed before
this refresh (the retired environment tool) are not added back by the recorder.
