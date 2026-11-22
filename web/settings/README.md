# Settings

## Source files

- [../settings.ts](../settings.ts) mounts the selected category and wires its
  controls. [layout.ts](layout.ts) builds rows, sub-pages and sheets.
- [models.ts](models.ts) edits model policy and effort levels; [safety.ts](safety.ts)
  edits safety review. [Draft defaults](draft-defaults/README.md) supplies
  preferences and new-subagent default snapshots.
- [auth.ts](auth.ts) and [two-factor.ts](two-factor.ts) own sign-in and two-factor
  settings. [backends.ts](backends.ts) and [backend-keys.ts](backend-keys.ts) manage
  remote connections and keys.
- [theme.ts](theme.ts) selects themes; [theme-css.ts](theme-css.ts) filters and
  adopts custom CSS. [notifications.ts](notifications.ts) manages per-browser Web Push.
- [updates.ts](updates.ts) shows release and update status and actions.

## Categories and saving

Only the open category is mounted; closing it removes its controls. Desktop
rows open sub-pages with a back link; phones use a category list and labelled
sheets. Escape, Back or Done returns to the row; resizing keeps edits.

Effort levels align badges before model names. Safety review shares that order
and always opens a sheet. Safe preferences autosave; credentials, passwords,
two-factor and model policy need confirmation. Prompt-cache warming saves
directly in Models.

[Page updates](../connection.ts) cover empty and draft pages. If unsent work
blocks an update, the gear shows a dot and an accessible label. The status and
Retry update button sit below the categories, not the composer. The button has
a 44 px phone target.

## Theme CSS

Custom CSS rejects network URLs and pauses for protected UI and visible Side
chats. Turning off safety review needs confirmation; parked Side frames are
inert. `?customCss=off` disables custom CSS and follows Side URLs. See the
[theme CSS hooks](../../docs/examples.md#theme-css).

## Rules for changes

Keep controls scoped to the open category. Preserve confirmation when safety
is reduced, and keep protected surfaces outside custom CSS.
