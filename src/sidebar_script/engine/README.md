# Sidebar script engine

The browser script worker and the server dry-run worker execute scripts in
QuickJS with no host APIs and the existing wall-clock and memory bounds.

## Source files

- [index.ts](index.ts): explicit engine exports and result type.
- [sandbox.ts](sandbox.ts): isolated execution and bounded error results.

## Rules for changes

Import through `index.ts`. Only the existing workers call `runSidebarScript`;
`tests/checks/static.ts` enforces those owners. Keep the execution, retry and
worker-readiness behavior unchanged across browser and backend callers.
