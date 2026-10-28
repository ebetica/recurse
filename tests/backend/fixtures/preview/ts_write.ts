import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyCase, type Spec } from "../attachments_common";
const fixture = (await Bun.file(
  new URL("./cases.json", import.meta.url).pathname,
).json()) as { cases: Array<{ spec: Spec }> };
for (const [index, c] of fixture.cases.entries()) {
  const root = join(process.argv[2]!, String(index));
  mkdirSync(root);
  await applyCase(root, c.spec);
}
