// Test-only Bun preload rewrites source markers, including in Workers.
import { plugin } from "bun";
import { tla } from "./rotation_record";

const recorder = new URL("./rotation_record.ts", import.meta.url).pathname;
plugin({
  name: "rotation trace markers",
  setup(build) {
    build.onLoad({ filter: /\/src\/.*\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      if (!source.includes("Spec: @tla"))
        return { contents: source, loader: "ts" };
      let contents = source
        .replace(/\/\/ Spec: @tla workers\n/g, "")
        .replace(/\/\* Spec: @tla worker \*\/\s*new Worker\(/g, "tlaWorker(")
        .replace(/\/\* Spec: @tla hold (.*?) \*\//g, "tlaHold($1, () =>")
        .replace(/\/\* Spec: @tla held \*\//g, ")")
        .replace(/\/\/ Spec: @tla ([\w-]+) (.*)/g, '__tla("$1", $2);');
      if (source.includes("// Spec: @tla workers\n"))
        contents = contents.replace(/\bnew Worker\(/g, "tlaWorker(");
      if (contents.includes("Spec: @tla"))
        throw new Error(`unrecognized rotation marker: ${path}`);
      tla("module", { p: path });
      return {
        contents: `import {tla as __tla,tlaId,tlaWorker,tlaHold,tlaConn,tlaNative,tlaRead,tlaDeleted,tlaMove} from ${JSON.stringify(recorder)};\n${contents}`,
        loader: "ts",
      };
    });
  },
});
