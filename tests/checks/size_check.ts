/** Source size gate and shared ledger policy for source and Markdown sweeps. */
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const SOURCE =
  /\.(?:[cm]?[jt]sx?|py|sh|bash|html?|css|scss|sass|less|vue|svelte|c|h|cc|cpp|hpp|rs|go|java|rb)$/i;
const SOURCE_SWEEP = 1500;
const SOURCE_CAP = 2500;
const MARKDOWN_SWEEP = 15_000;
const WARN_LINES = 1000;
const LEDGER = "tests/checks/architecture-sweeps.json";

/** Read exact paths and the size last reviewed by the Coordinator's sweep. */
export function readSweepLedger(): ReadonlyMap<string, number> {
  const records: unknown = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (!Array.isArray(records))
    throw new Error(
      "architecture-sweeps.json: expected an array of sweep records",
    );
  const sizes = new Map<string, number>();
  for (const record of records as Array<{
    path?: unknown;
    head?: unknown;
    size?: unknown;
  } | null>) {
    const { path, head, size } = record ?? {};
    if (
      typeof path !== "string" ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof head !== "string" ||
      !/^[0-9a-f]{40}$/.test(head) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < (path.endsWith(".md") ? MARKDOWN_SWEEP : SOURCE_SWEEP) ||
      sizes.has(path)
    ) {
      throw new Error(
        `architecture-sweeps.json: invalid or duplicate record ${JSON.stringify(record)}`,
      );
    }
    sizes.set(path, size);
  }
  return sizes;
}

/** Above the reviewed size, the next sweep is required again. */
export function sweepProblem(
  file: string,
  size: number,
  ledger: ReadonlyMap<string, number>,
): string | undefined {
  const markdown = file.endsWith(".md");
  const threshold = markdown ? MARKDOWN_SWEEP : SOURCE_SWEEP;
  if (size < threshold || size <= (ledger.get(file) ?? 0)) return;
  const scope =
    basename(file) === "README.md" ? ` of the folder ${dirname(file)}/` : "";
  return `${file}: ${size} ${markdown ? "characters" : "lines"}. Stop: do not trim or delete content to fit. Report this to the Coordinator for an effort-4 architecture sweep${scope} under docs/agents/simplify-review.md.`;
}

/** Keep vendored, built, patch, fixture and lock files out of the source gate. */
export function sourceSizes(): { errors: string[]; warnings: string[] } {
  const listed = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--",
    ".",
    ":(glob,exclude)" + ["play", "ground"].join("") + "/**",
    ":(glob,exclude)web/vendor/**",
    ":(glob,exclude)web/dist/**",
    ":(glob,exclude)scripts/patches/**",
    ":(glob,exclude)**/fixtures/**",
    ":(glob,exclude)**/*.lock",
  ]);
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  const ledger = readSweepLedger();
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const file of listed.stdout.toString().split("\0").filter(Boolean)) {
    if (lstatSync(file).isSymbolicLink()) continue;
    const text = readFileSync(file, "utf8");
    if (!SOURCE.test(file) && !text.startsWith("#!")) continue;
    const lines =
      text.split("\n").length - Number(text.endsWith("\n") || !text);
    const problem = file.endsWith(".md")
      ? undefined
      : sweepProblem(file, lines, ledger);
    if (problem) errors.push(problem);
    if (lines > SOURCE_CAP)
      errors.push(
        `${file}: ${lines} lines exceeds the ${SOURCE_CAP}-line hard cap. A sweep does not waive the cap.`,
      );
    else if (!problem && lines >= WARN_LINES)
      warnings.push(
        `${file}: ${lines} lines (maximum ${SOURCE_CAP}). Before adding more, check whether the file has more than one job.`,
      );
  }
  return { errors, warnings };
}

if (import.meta.main) {
  const { errors } = sourceSizes();
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}
