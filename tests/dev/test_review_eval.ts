/**
 * Runs docs/agents/test-review.md per case file; prints verdict recall.
 * Usage: bun tests/dev/test_review_eval.ts CASES_DIR [--effort N --parallel N]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...args] = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const effort = flag("--effort", "3");
const parallel = Number(flag("--parallel", "5"));
const rules = readFileSync(
  join(import.meta.dir, "../../docs/agents/test-review.md"),
);
const cli = join(process.env.RECURSE_SRC!, "tools/subagent.ts");

async function subagent(...argv: string[]) {
  const proc = Bun.spawn(["bun", cli, ...argv], { stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if (await proc.exited)
    throw new Error(await new Response(proc.stderr).text());
  return out;
}

const cases = readdirSync(dir!)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => {
    const [, front, text] = readFileSync(join(dir!, name), "utf8").match(
      /^---\n([\s\S]*?)\n---\n([\s\S]*)$/,
    )!;
    const field = (key: string) =>
      front!.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1] ?? "";
    const rule = field("rule");
    const also = field("also").split(" ");
    return {
      id: name.slice(0, -3),
      expected: field("expected"),
      rule,
      also,
      text,
    };
  });

const prompt = (text: string) =>
  `You are a test reviewer. Apply the rules below to the PR excerpt after them.
Inspect code only at the excerpt's base commit (git grep -n PATTERN BASE -- tests/, git show BASE:PATH); never read the working tree, later history or other files.
Edit nothing and create no agents. Your final message is the verdict, in the rules' format.

<rules>
${rules}
</rules>

<pr>
${text.trim()}
</pr>`;

async function review(c: (typeof cases)[number]) {
  let id = "";
  let reply = "";
  try {
    const title = `Test review ${c.id.slice(0, 3)}`;
    const created = await subagent(
      "create",
      "--title",
      title,
      "--effort",
      effort,
      prompt(c.text),
    );
    id = created.match(/subagent ([0-9a-f]{12})/)![1]!;
    for (let i = 0; i < 120 && !reply.includes("VERDICT:"); i++) {
      await Bun.sleep(10_000);
      const rows = (await subagent("messages", id, "--limit", "10"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { role?: string; text?: string });
      reply =
        rows.findLast(
          (row) => row.role === "assistant" && row.text?.includes("VERDICT:"),
        )?.text ?? "";
    }
  } catch (error) {
    reply = `ERROR ${error}`;
  }
  if (id) await subagent("rm", id);
  const got = reply.match(/^VERDICT: (PASS|FLAG)/m)?.[1] ?? "NONE";
  const cited = [...new Set(reply.match(/^R\d\b/gm))];
  const ok = got === c.expected && (got === "PASS" || cited.includes(c.rule));
  console.log(
    `${ok ? "ok " : "BAD"} ${c.id} want ${c.expected} ${c.rule} got ${got} ${cited}\n${reply}\n`,
  );
  return { ...c, ok, cited };
}

const queue = [...cases];
const results: Awaited<ReturnType<typeof review>>[] = [];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    for (let c = queue.shift(); c; c = queue.shift())
      results.push(await review(c));
  }),
);
console.log(
  `effort ${effort}: ${results.filter((r) => r.ok).length}/${results.length} correct`,
);
for (let n = 1; n <= 9; n++) {
  const rule = `R${n}`;
  const cited = results.filter((r) => r.cited.includes(rule));
  const labelled = results.filter((r) => r.rule === rule);
  const right = cited.filter((r) => r.rule === rule || r.also.includes(rule));
  console.log(
    `${rule} recall ${labelled.filter((r) => r.cited.includes(rule)).length}/${labelled.length} precision ${right.length}/${cited.length}`,
  );
}
