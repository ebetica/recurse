/** Keep extra extensions off host modules; allow only existing adapter imports. */
import { posix } from "node:path";
import ts from "typescript";

const EXTENSIONS = "src/extensions";
const EXTRA = `${EXTENSIONS}/extra`;
const HOST_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "codex/compaction.ts": ["../../../auth/codex.ts"],
  "fff/fff_worker.ts": [
    "../../../observability/slow-span",
    "../../../process_lifecycle.ts",
    "../../../utils/tasks.ts",
  ],
  "mcp/mcp.ts": [
    "../../../observability/slow-span",
    "../../../process_lifecycle.ts",
  ],
};

const files = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
let scanned = 0;
let violations = 0;
for (const path of [...files.scanSync({ cwd: EXTRA })].sort()) {
  const file = `${EXTRA}/${path}`;
  const source = await Bun.file(file).text();
  scanned++;
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true)
    .importedFiles) {
    const target = posix.normalize(
      specifier.startsWith(".")
        ? posix.join(posix.dirname(file), specifier)
        : specifier,
    );
    if (target !== "src" && !target.startsWith("src/")) continue;
    if (target === EXTENSIONS || target.startsWith(`${EXTENSIONS}/`)) continue;
    if (HOST_IMPORTS[path]?.includes(specifier)) continue;
    console.error(
      `${file}: ${specifier} imports a host module. Pass host values into the extension instead.`,
    );
    violations++;
  }
}
console.log(
  `extra extension imports: ${scanned} files, ${violations} violations`,
);
if (violations) process.exitCode = 1;
