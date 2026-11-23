# Browser test notes

## Shared test setup

The [shared setup helpers](common.ts) keep page creation and screenshot file
handling in one place so the groups can focus on navigation and assertions.
A fresh server can run without a Settings directory, so fixtures that write
Settings files directly create their own parent directories.

## Artifact comments

[Text](test_artifact_comments.ts) and [image](test_artifact_image_comments.ts)
comment tests share a group separate from `panes-artifacts`, which owns [pane
navigation](test_panes_artifacts.ts) and [publication refreshes](test_artifact_updates.ts).
Run the publication cases with
`bun tests/mobile_browser/test_artifact_updates.ts` after building `web/dist`.

## Hold confirmations

Run [Stop](test_stop_confirm.ts) and [touch Delete](test_hold_confirm.ts)
with `bun tests/mobile_browser/index.ts hold-confirm` to check confirmation
without running the rest of the composer or header suites.

## Composer effort

Run the [composer effort cases](test_composer_effort.ts) with
`bun tests/mobile_browser/test_composer_effort.ts` after building `web/dist`,
without running the general composer send or layout cases.

## Explorer and composer file mentions

The [composer cases](test_composer.ts) own `#` file completion, including
cancellation when switching workspaces. The [Explorer cases](test_explorer.ts)
cover browsing, previews, and search.

## Sidebar tags

Run the [typed tags and tag updates](test_sidebar_tags.ts) with
`bun tests/mobile_browser/index.ts sidebar-tags` without running the general sidebar cases.

## First load

Run the [first-load cases](test_first_load.ts) with `bun tests/mobile_browser/index.ts first-load`
to check startup and draft retention without running the composer, mobile layout, or pane hotkey groups.

## Agent navigation

The `new-agent-focus` group covers [keyboard ownership and folds](test_new_agent_focus.ts)
and [agent links, phone list history, and pane Back](test_agent_navigation.ts).
Run the navigation cases alone with `bun tests/mobile_browser/test_agent_navigation.ts`
after building `web/dist`.

## Changes

The [Changes group](test_changes_expand.ts) covers patch loading and truncated
summaries alongside line expansion. [Turns](test_turns.ts) covers conversation
history and reply controls.

## Touch selection

The [edge-drag test](test_long_selection.ts) uses live drag targets because
background refreshes can repaint the title and composer between moves.

## Notifications

The [notification-click test](test_notification_clicks.ts) uses real desktop
notifications because a synthetic `NotificationEvent` does not grant a service
worker permission to focus or open a window. See the [CI workflow](../../.github/workflows/ci.yml)
for the system packages.

## Compaction

The [compaction group](test_compact_rows.ts) uses a held fake-provider summary to
exercise the transition from visible progress to a summary or a failure.

## Imported Pi history

The messages in the [imported snapshot](fixtures/imported-pi.jsonl) come unchanged
from [Durable rows entries](../backend/fixtures/durable_rows/recorded.json) 7, 12,
15, 16 and 18, recorded from a real model by
[durable_rows_record.ts](../live/durable_rows_record.ts). The envelopes follow the
[backend Pi import test](../backend/pi_import.test.ts). Compaction has a separate
import from the [recorded automatic prefix](../backend/fixtures/compaction/real-shapes.json):
only the missing predecessor of the first entry is replaced with `null`. Both
the completion notice's parent and its retained entry stay as recorded. The cut
is at a tool-only assistant entry, so the jump highlights the next visible
reply, not the earlier reply. The failure marker comes from a
[separate captured Pi session](../backend/fixtures/pi_import/README.md).

The [older wire page](fixtures/legacy-compaction-view.json) is the `a2b8e341c`
server view serialization of the same automatic prefix through `entry-30`.
The browser removes only `summaryEntryId` from the notice to test the implicit
lookup. The provisional divider's `compact_provisional.pointId` is unchanged.
