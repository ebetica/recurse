# Shared agent metadata

Browser sidebar rows and backend snapshots share tag validation, expiry and the
API Agent projection without importing agent lifecycle or HTTP implementations.
The Agent type comes from the [shared API schema](../web/api_v1/schema/)
through a type-only export.

## Source files

- [index.ts](index.ts): explicit public values and types.
- [tags.ts](tags.ts): tag validation, expiry and operator-only tag rules.
- [agent.ts](agent.ts): status normalization and cached Agent projection.

## Rules for changes

Import through `index.ts`. Keep this module free of I/O and lifecycle owners.
Preserve operator-only tag authorization and the API projection contract; the
real-server coverage lives in `tests/backend/sidebar_tags.test.ts`,
`tests/backend/sidebar_script.test.ts` and `tests/backend/api_v1.test.ts`.
