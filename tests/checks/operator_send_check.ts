import ts from "typescript";

const started = performance.now();
const owner = "web/conversation/operator-send.ts";
const allowed = new Map([
  [
    "deliverQueuedOperatorMessage",
    new Set([
      `${owner}:sendOperatorMessage`,
      "web/composer.ts:runJob",
      "web/artifacts/comment-outbox.ts:attempt",
    ]),
  ],
  [
    "addOptimisticPending",
    new Set([
      "web/composer.ts:jobSucceeded",
      "web/artifacts/comment-outbox.ts:attempt",
    ]),
  ],
  [
    "deliverStop",
    new Set([
      "web/conversation/stop.ts:requestStop",
      "web/conversation/stop.ts:requestIdleProcessStop",
    ]),
  ],
]);
let failures = 0;
let files = 0;
for await (const file of new Bun.Glob("web/**/*.{ts,tsx,js,mjs}").scan(".")) {
  if (file.startsWith("web/dist/") || file.startsWith("web/vendor/")) continue;
  files++;
  const source = ts.createSourceFile(
    file,
    await Bun.file(file).text(),
    ts.ScriptTarget.Latest,
    true,
  );
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements)
        aliases.set(entry.name.text, (entry.propertyName ?? entry.name).text);
  }
  const nameOf = (expression: ts.Expression): string => {
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : "";
    return aliases.get(name) ?? name;
  };
  const report = (node: ts.Node, reason: string) => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    console.error(`${file}:${line + 1}: ${reason}`);
    failures++;
  };
  const visit = (node: ts.Node, scope: string, foreground: boolean) => {
    if (ts.isFunctionDeclaration(node)) scope = node.name?.text ?? "";
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression);
      const callers = allowed.get(name);
      if (callers && !callers.has(`${file}:${scope}`))
        report(
          node,
          `${name} bypasses startOperatorSend; use sendOperatorMessage or enqueue inside startOperatorSend`,
        );
      if (name === "startOperatorSend") foreground = true;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "push"
      ) {
        const queue = node.expression.expression.getText(source);
        const restoration =
          (file === "web/composer.ts" && scope === "restoreAfterLogin") ||
          (file === "web/artifacts/comment-outbox.ts" && scope === "reconcile");
        if (
          ((file === "web/composer.ts" && queue === "jobs") ||
            (file === "web/artifacts/comment-outbox.ts" &&
              queue === "sends")) &&
          !foreground &&
          !restoration
        )
          report(node, "foreground enqueue must be inside startOperatorSend");
      }
    }
    if (
      file !== owner &&
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      /\/deliver(?:[/?#]|$)/.test(node.text)
    )
      report(
        node,
        "deliver endpoint belongs to conversation/operator-send.ts; use sendOperatorMessage",
      );
    ts.forEachChild(node, (child) => visit(child, scope, foreground));
  };
  visit(source, "", false);
}
console.log(
  `operator send check: ${files} files, ${failures} violations (${((performance.now() - started) / 1000).toFixed(2)}s)`,
);
if (failures) process.exit(1);
