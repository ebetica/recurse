/**
 * HTTP route handlers await what they start: a discarded promise lets the
 * response overtake the work's admission (#3440). static.ts runs it.
 */
import ts from "typescript";

const REGISTER = new Set(["add", "get", "post", "put", "delete"]);

/** Error lines for `void` statements inside router-registered handlers. */
export function checkFiles(
  files: readonly { file: string; text: string }[],
): string[] {
  return files.flatMap(({ file, text }) => {
    if (!/router\.(?:add|get|post|put|delete)\(/i.test(text)) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const errors: string[] = [];
    const discarded = (node: ts.Node) => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isVoidExpression(node.expression)
      )
        errors.push(
          `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ` +
            "await this in the route handler; a discarded promise lets the response overtake the work's admission",
        );
      ts.forEachChild(node, discarded);
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        REGISTER.has(node.expression.name.text) &&
        /router$/i.test(node.expression.expression.getText(source))
      )
        for (const arg of node.arguments)
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
            discarded(arg.body);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return errors;
  });
}
