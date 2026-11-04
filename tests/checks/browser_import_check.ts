import { builtinModules } from "node:module";
import { relative } from "node:path";

const started = performance.now();
const { scripts } = await Bun.file("package.json").json();
const entrypoints = /^bun build (.+?) --/
  .exec(scripts.build)?.[1]
  ?.split(/\s+/);
if (
  !entrypoints?.length ||
  entrypoints.some((entry) => !entry.startsWith("web/"))
)
  throw new Error(
    "Cannot read browser entrypoints from package.json scripts.build",
  );

const builtins = new Set(builtinModules);
const serverPackages = [
  "dotenv",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-durable",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-tui",
  "@ff-labs/pi-fff",
];
const serverOnly = (specifier: string) =>
  specifier.startsWith("node:") ||
  specifier === "bun" ||
  specifier.startsWith("bun:") ||
  builtins.has(specifier) ||
  serverPackages.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );

const forbidden = new Map<string, Set<string>>();
const config: Parameters<typeof Bun.build>[0] & { metafile: true } = {
  entrypoints,
  target: "browser",
  splitting: false,
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  plugins: [
    {
      name: "browser-server-boundary",
      setup(build) {
        build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
          if (!serverOnly(path)) return;
          const file = relative(process.cwd(), importer);
          if (!forbidden.has(file)) forbidden.set(file, new Set());
          forbidden.get(file)!.add(path);
          return { path, external: true };
        });
      },
    },
  ],
};
const result = (await Bun.build(config)) as Awaited<
  ReturnType<typeof Bun.build>
> & {
  metafile: {
    inputs: Record<string, { imports: { path: string }[] }>;
  };
};
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const inputs = result.metafile.inputs;
let failures = 0;
for (const entry of entrypoints) {
  const seen = new Set([entry]);
  const queue = [[entry]];
  for (const chain of queue) {
    const file = chain.at(-1)!;
    if (!inputs[file])
      throw new Error(`Missing browser import graph for ${file}`);
    for (const specifier of forbidden.get(file) ?? []) {
      console.error(
        `Browser imports server-only module:\n  ${[...chain, specifier].join("\n  -> ")}`,
      );
      failures++;
    }
    for (const imported of inputs[file].imports) {
      if (inputs[imported.path] && !seen.has(imported.path)) {
        seen.add(imported.path);
        queue.push([...chain, imported.path]);
      }
    }
  }
}
console.log(
  `browser import check: ${entrypoints.length} entries, ${Object.keys(inputs).length} modules, ${failures} violations (${((performance.now() - started) / 1000).toFixed(2)}s)`,
);
if (failures) process.exit(1);
