/**
 * Every var(--name) the app reads is declared in markup, a stylesheet or the
 * generated theme; setProperty overrides still need a resting declaration.
 */
import { StyleFile, type StyleText } from "./style_file.ts";

const DECLARATION = /(?<![\w-])(--[\w-]+)\s*:/g;
const COMMENT = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g;
const REFERENCE = /var\(\s*(--[\w-]+)/g;

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** Error lines for references no file or extra name declares. */
export function checkFiles(
  files: readonly StyleText[],
  declaredElsewhere: Iterable<string> = [],
): string[] {
  const views = files.map((input) => ({
    file: input.file,
    view: (input.file.endsWith(".ts")
      ? StyleFile.from(input).code
      : input.text
    ).replace(COMMENT, blank),
  }));
  const declared = new Set(declaredElsewhere);
  for (const { view } of views)
    for (const [, name] of view.matchAll(DECLARATION)) declared.add(name!);
  const errors: string[] = [];
  for (const { file, view } of views)
    for (const match of view.matchAll(REFERENCE))
      if (!declared.has(match[1]!))
        errors.push(
          `${file}:${view.slice(0, match.index).split("\n").length}: var(${match[1]}) is never declared; declare it in a stylesheet (for example :root)`,
        );
  return errors;
}
