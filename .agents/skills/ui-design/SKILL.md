---
name: ui-design
description: "Rules for any web UI change (web/), from Material Design 3 and NN/g."
---

# UI design rules

Apply the rules to the UI you change; don't widen a task to fix existing
violations elsewhere. Sources: **M3** = m3.material.io, **NN/g** = nngroup.com.
**Recurse** marks a decision this repository has already made (AGENTS.md,
`web/README.md`); it wins over the sources. Cite rule ids (for example `C4`)
in PRs and reviews.

Check layout and text in screenshots (desktop 1280 px and phone 412 px,
light and dark themes help). Check keyboard use, accessible names and hit
areas by interacting, not from screenshots.

## S. Structure: what to show, where

- **S1 Show the frequent, hide the rare.** Keep what most people need on
  the first screen. Move rarely used or advanced options behind one clearly
  labelled step. Stop at two levels; a third level means simplify.
  [NN/g](https://www.nngroup.com/articles/progressive-disclosure/)
- **S2 Group by job, order by use.** Put related settings under one short
  heading. Most-used group first; most-used item first in each group. A group
  with one item belongs in a neighbouring group.
  [NN/g](https://www.nngroup.com/articles/gestalt-proximity/)
- **S3 Fewer choices, faster decisions.** Every extra option slows the
  choice. Remove what doesn't help the task before adding a way to hide it.
  [NN/g](https://www.nngroup.com/videos/hicks-law-long-menus/)
- **S4 One focal point.** What you see first in a section should be its
  main task. **Recurse:** at most one primary (accent-filled) button per section, for
  its main action.
  [NN/g](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/)
- **S5 Controls sit next to what they change.** Put actions beside the item
  or content they affect, and the submit action right after the last field.
  [M3](https://m3.material.io/foundations/layout/understanding-layout/spacing)
- **S6 Keep dangerous actions away from routine ones.** Separate destructive
  or hard-to-undo actions by space and a distinct style (danger colour,
  separate group).
  [NN/g](https://www.nngroup.com/articles/proximity-consequential-options/)
- **S7 Don't show empty containers.** Hide a section with nothing in it. When
  an empty area is where the user creates things, show one status line and
  the action that fills it.
  [NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)
- **S8 Same thing, same everywhere.** One word, icon, control and place per
  concept; follow common web conventions. Reuse an existing component before
  making a new one.
  [NN/g](https://www.nngroup.com/articles/consistency-and-standards/)

## C. Controls: pick the right one

- **C1 Choose the control by the kind of choice.**
  | Choice | Control |
  |---|---|
  | On/off, takes effect at once | switch |
  | On/off or several of many, applied by a Save button | checkboxes |
  | One of 2–5 short options | segmented buttons or radio buttons, all visible |
  | One of about 5–15, secondary to the task | dropdown menu |
  | One of many, or the user knows the name | list with type-to-filter (**Recurse:** the shared fuzzy matcher, `web/fuzzy-match.ts`) |
  | Approximate value on a continuous range | slider |
  [NN/g](https://www.nngroup.com/articles/dropdown-list/)
- **C2 Switches and sliders apply immediately.** No Save button behind them.
  If a change can't apply at once, use a checkbox and a Save button.
  [M3](https://m3.material.io/components/switch/guidelines)
- **C3 Sliders only when the exact value doesn't matter.** Discrete values
  that each mean something different (a model, a mode) are not slider
  material; show them as options. A slider's value label sits above or beside
  the thumb, never under the finger. **Recurse exception:** the composer's
  five-stop effort-level slider.
  [NN/g](https://www.nngroup.com/articles/gui-slider-controls/)
- **C4 A switch is never two opposing options or an action.** List-or-grid is
  a segmented control; "do it now" is a button.
  [M3](https://m3.material.io/components/switch/guidelines)
- **C5 Radio groups always have one option selected.** Preselect the most
  common safe choice; add an explicit "None" option if skipping is allowed.
  [NN/g](https://www.nngroup.com/articles/radio-buttons-default-selection/)
- **C6 Buttons.** Label 1–3 words, a verb naming the result ("Delete agent",
  not "OK"), sentence case, one line, never truncated. **Recurse:** shared
  text buttons use `.btn`, `.btn.primary`, `.btn.quiet`, `.btn.sm` (Settings
  rows have their own variants); no new one-off button styles.
  [M3](https://m3.material.io/components/buttons/guidelines)
- **C7 Item menus (⋯).** Secondary actions on one item, opened by a click
  next to it. Show unavailable items disabled, not removed. Don't hide one or
  two actions in a menu when there is room to show them. ☰ is only for main
  navigation.
  [NN/g](https://www.nngroup.com/articles/contextual-menus-guidelines/)
- **C8 Dropdowns.** Keep the field label visible while open; no dropdown whose
  options change based on another dropdown; avoid lists that need scrolling.
  [NN/g](https://www.nngroup.com/articles/drop-down-menus/)
- **C9 Text fields have a visible label outside the field.** A placeholder is
  only an example value, never the label or the instructions.
  [NN/g](https://www.nngroup.com/articles/form-design-placeholders/)
- **C10 Toggle buttons show state and action.** A one-button toggle (mute,
  pin) must make the current state and the result of a click obvious.
  [NN/g](https://www.nngroup.com/articles/state-switch-buttons/)
- **C11 Dialogs only to block for a decision.** Headline is a specific
  question or statement (never "Are you sure?"); at most two actions, named
  by result; dismiss on the left, confirm on the right; dismiss is never
  disabled. Low-priority news is inline text or a toast, not a dialog.
  [M3](https://m3.material.io/components/dialogs/guidelines)
- **C12 Confirm what can't be undone or lowers safety** (turning off safety
  review); prefer undo for the rest. Say exactly what will be lost; Enter
  must not trigger the destructive button.
  [NN/g](https://www.nngroup.com/articles/confirmation-dialog/)
- **C13 Chips are sets of optional, contextual choices or filters.** Never a
  lone chip, never the step that completes a task (that's a button).
  [M3](https://m3.material.io/components/chips/guidelines)
- **C14 Icons get words.** Icon-only controls are for icons people already
  know (close, search, send, copy); they need a tooltip and an accessible
  name describing the action. Everything else shows a text label.
  [NN/g](https://www.nngroup.com/articles/icon-usability/)

## T. Text and labels

- **T1 Users' words, not ours.** **Recurse:** no implementation names
  (environment variables, file paths, internal terms), unexplained acronyms
  or jargon; name the observable behaviour; label every control.
  [NN/g](https://www.nngroup.com/articles/technical-jargon/)
- **T2 Explain only consequences.** **Recurse:** add a sentence only for a
  consequence the user can't infer (data loss, what is or isn't shared,
  irreversible actions) or for an actionable error. State it neutrally: what
  happens and how to undo it, without alarm.
  [M3](https://m3.material.io/foundations/content-design/style-guide)
- **T3 Sentence case** for headings, buttons, menu items, tabs and labels.
  [M3](https://m3.material.io/foundations/content-design/style-guide)
- **T4 Short and front-loaded.** Put the distinguishing word first so labels
  scan; tabs 1–2 words.
  [NN/g](https://www.nngroup.com/articles/menu-design/)
- **T5 Switch and checkbox labels describe the On state**, positively ("Send
  notifications", not "Disable notifications" or "Notification mode").
  [NN/g](https://www.nngroup.com/articles/toggle-switch-guidelines/)
- **T6 Commands say what will happen.** Verbs for actions; "…" when the
  command asks for more input before acting.
  [NN/g](https://www.nngroup.com/articles/ui-copy/)
- **T7 Nothing vital in a tooltip.** Tooltips name icon-only controls or add
  brief extras; they must also appear on keyboard focus.
  [NN/g](https://www.nngroup.com/articles/tooltip-guidelines/)
- **T8 Spell it out.** No "e.g.", "etc." or avoidable abbreviations.
  [M3](https://m3.material.io/foundations/content-design/style-guide)
- **T9 Links name their destination**, never a bare "Learn more".
  [NN/g](https://www.nngroup.com/articles/learn-more-links/)

## L. Layout, spacing, density, type

- **L1 Space from tokens.** Padding, margin and gap use `--space-1`…`--space-6`
  (2, 4, 8, 12, 16, 24 px). Related items sit closer than unrelated ones; a
  label sits nearer its own control than the next one.
  [M3](https://m3.material.io/foundations/layout/understanding-layout/spacing)
- **L2 Rows align.** In a list every row puts the same element in the same
  place: icon leading, label, supporting text (when needed) below, control
  or value trailing. Give icons to every item in a list or to none.
  [M3](https://m3.material.io/components/lists/guidelines)
- **L3 Colours from theme tokens** (`--text`, `--muted`, `--accent`,
  `--panel-2`, `--border`, `--danger`, …), never literals; check light and
  dark themes. Text contrast at least 4.5:1 (3:1 for large text and control
  outlines).
  [M3](https://m3.material.io/foundations/designing/color-contrast)
- **L4 Font sizes from the type scale.** 11, 11.5, 12.5, 13.5, 15, 16, 17
  or 20 px at a 16 px root; `tests/checks/font_check.ts` checks px and rem,
  not em. Use rem so desktop's 90% root scales them (Dockview tab sizes stay
  px). Body text at least 12 px, labels at least 11 px.
  [M3](https://m3.material.io/styles/typography/applying-type)
- **L5 Desktop shows, phone stacks.** Desktop shows navigation and a second
  pane; phone shows one pane at a time and turns long menus into bottom
  sheets (small popovers are fine). **Recurse:** the phone layout starts at
  700 px wide or less.
  [M3](https://m3.material.io/foundations/layout/applying-layout/window-size-classes)
- **L6 Keep prose readable.** Cap the width of long text blocks instead of
  letting lines run the full pane.
  [M3](https://m3.material.io/foundations/layout/applying-layout/window-size-classes)
- **L7 Density never shrinks a target.** Compact layouts reduce padding and
  gaps around content, not hit areas below the A1 minimums.
  [M3](https://m3.material.io/foundations/layout/understanding-layout/density)

## A. Touch and accessibility

- **A1 Target sizes.** **Recurse:** on coarse pointers (phone) every target's
  hit area should be at least 44 × 44 px (some, such as the tool copy button,
  still miss); pad small icons rather than enlarging them. On desktop keep
  the `.btn` (40 px) and `.btn.sm` (36 px) minimum heights. Prove the real
  clickable area with `elementFromPoint` at its four inset corners.
  [M3](https://m3.material.io/foundations/designing/structure)
- **A2 Don't crowd targets.** Leave about 8 px between adjacent targets, more
  between opposing actions.
  [M3](https://m3.material.io/foundations/designing/structure)
- **A3 The label is part of the target.** Clicking a checkbox, radio or
  switch label or its whole settings row toggles it.
  [NN/g](https://www.nngroup.com/articles/checkboxes-vs-radio-buttons/)
- **A4 Everything works from the keyboard.** Tab reaches every control in
  reading order, arrows move inside menus and lists, Enter activates, Escape
  closes. Focus is always visible. Opening a dialog or sheet moves focus into
  it; closing returns focus to the control that opened it.
  [M3](https://m3.material.io/foundations/designing/flow)
- **A5 Accessible names describe the action,** not the picture
  ("Close panel", not "X"), and never include the role word ("button").
  [M3](https://m3.material.io/foundations/designing/elements)
- **A6 State is never colour alone.** Pair colour with an icon, shape, weight
  or text.
  [M3](https://m3.material.io/components/icon-buttons/guidelines)
- **A7 Single-key shortcuts** fire only while the relevant element has focus,
  or can be turned off.
  [M3](https://m3.material.io/foundations/designing/flow)

## F. Feedback, status and errors

- **F1 Respond in time.** Visible response (pressed state, spinner) within
  0.1 s; a progress indicator for anything over 1 s; for over 10 s, say what
  is happening and let the user keep working.
  [NN/g](https://www.nngroup.com/articles/response-times-3-important-limits/)
- **F2 Never hide work in progress.** **Recurse:** show live state, tools,
  partial output and actionable failures.
  [NN/g](https://www.nngroup.com/articles/visibility-system-status/)
- **F3 Errors sit next to their cause** in plain words: what went wrong and
  how to fix it. Keep the user's input; never only a tooltip or a summary.
  [NN/g](https://www.nngroup.com/articles/error-message-guidelines/)
- **F4 Prevent slips with defaults and constraints.** Prefill the common
  answer; disable (don't hide) actions that can't run yet and say why when it
  isn't obvious.
  [NN/g](https://www.nngroup.com/articles/slips/)
- **F5 Toasts are brief and never the only record.** One at a time, one
  short sentence, at most one text action, no links. Anything that matters
  also shows inline where it happened.
  [M3](https://m3.material.io/components/snackbar/guidelines)

## N. Navigation

- **N1 Navigation is visible by default on desktop.** The user may hide it;
  only phone hides it by default.
  [NN/g](https://www.nngroup.com/articles/hamburger-menus/)
- **N2 Show where the user is.** The current agent, Settings category, tab or
  pane is visibly selected.
  [NN/g](https://www.nngroup.com/articles/menu-design/)
- **N3 Leaving steps out one level.** Escape or a visible close control
  closes the top sheet or popover. Stack sheets only for a drill-down (phone
  Settings).
  [NN/g](https://www.nngroup.com/articles/bottom-sheet/)
- **N4 Recognition over recall.** Show options, recent items and current
  values instead of making people remember names or commands.
  [NN/g](https://www.nngroup.com/articles/recognition-and-recall/)
- **N5 Shortcuts add to, never replace, a visible path.** Show each shortcut
  in the tooltip or menu item of the action it triggers.
  [NN/g](https://www.nngroup.com/articles/ui-accelerators/)

## Where the sources disagree

Recurse's choice is recorded in the rules above; reopen it only with the
operator.

- **Touch targets.** M3 48 px, NN/g about 38 px, Apple 44; Recurse aims for
  44 on phone and keeps 36–40 px minimum heights on desktop (A1).
- **Density.** M3 makes dense layouts opt-in; Recurse is compact by default
  and protects targets (L7).
- **Discrete sliders.** M3 allows stops; NN/g doesn't. Recurse follows NN/g,
  except the effort-level slider (C3).
- **Icon-only buttons.** NN/g wants text on every icon; M3 allows tooltips.
  Recurse allows icon-only for well-known icons (C14).
