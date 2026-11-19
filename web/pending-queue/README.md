# Optimistic sends

This module tracks just-sent messages until the rebuilt thread contains their
committed rows. The row-thread state supplies the newest committed offset and
passes its loaded window to reconciliation. The [thread renderer](../conversation/thread.ts)
owns the queue bubbles and their retry and removal actions. It records optimistic
sends and repaints the selected thread.

Matching and expiry rules live in [pending-message.ts](pending-message.ts).
