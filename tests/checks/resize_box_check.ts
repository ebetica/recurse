/**
 * ResizeObserver.observe() calls name the box that runs the callback; padding
 * or a scrollbar can resize one box but not the other.
 */
import ts from "typescript";
import { StyleFile, type StyleText } from "./style_file.ts";

const OPTIONS: ts.CompilerOptions = {
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  noResolve: true,
  noEmit: true,
  types: [],
  target: ts.ScriptTarget.ES2022,
};

const isResizeObserver = (type: ts.Type): boolean =>
  type.isUnion()
    ? type.types.some(isResizeObserver)
    : type.getSymbol()?.getName() === "ResizeObserver";

/** Error lines for observe() calls on a ResizeObserver without a box option. */
export function checkFiles(files: readonly StyleText[]): string[] {
  const inputs = new Map(
    files
      .filter(
        ({ file, text }) => file.endsWith(".ts") && /ResizeObserver/.test(text),
      )
      .map((input) => [input.file, StyleFile.from(input)]),
  );
  if (!inputs.size) return [];
  const host = ts.createCompilerHost(OPTIONS);
  const readLib = host.getSourceFile;
  host.getSourceFile = (name, version) =>
    inputs.get(name)?.source ?? readLib(name, version);
  const program = ts.createProgram([...inputs.keys()], OPTIONS, host);
  const checker = program.getTypeChecker();
  const errors: string[] = [];
  for (const file of inputs.keys()) {
    const source = program.getSourceFile(file)!;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "observe" &&
        isResizeObserver(checker.getTypeAtLocation(node.expression.expression))
      ) {
        const options = node.arguments[1];
        if (
          !options ||
          !ts.isObjectLiteralExpression(options) ||
          !options.properties.some(
            (property) => property.name?.getText(source) === "box",
          )
        )
          errors.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ResizeObserver.observe() needs { box: "content-box" } or { box: "border-box" }: the size whose change should run its callback`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return errors;
}
