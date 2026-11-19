/** Find JS/TS comment trivia without scanning through literal contents. */
import ts from "typescript";

export function hasCommentOpener(text: string): boolean {
  return /\/[/*]/.test(text);
}

export function scanTsComments(
  source: ts.SourceFile,
  onNode?: (node: ts.Node) => void,
): { top: number; ranges: ts.CommentRange[] } {
  const text = source.text;
  const literals: { start: number; end: number }[] = [];
  const collect = (node: ts.Node) => {
    onNode?.(node);
    if (ts.isJsxText(node)) literals.push({ start: node.pos, end: node.end });
    else if (
      ts.isStringLiteralLike(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateLiteralToken(node)
    )
      literals.push({ start: node.getStart(source), end: node.end });
    ts.forEachChild(node, collect);
  };
  collect(source);
  const scanner = ts.createScanner(
    source.languageVersion,
    false,
    source.languageVariant,
    text,
  );
  const top =
    scanner.scan() === ts.SyntaxKind.ShebangTrivia ? scanner.getTextPos() : 0;
  const ranges: ts.CommentRange[] = [];
  // Jump to possible openers; the AST excludes slashes inside literals.
  const opener = /\/[/*]/g;
  opener.lastIndex = top;
  let index = 0;
  for (let match; (match = opener.exec(text)); ) {
    const pos = match.index;
    while (index < literals.length && literals[index]!.end <= pos) index++;
    const literal = literals[index];
    if (literal && literal.start <= pos) {
      // A regex's closing slash may touch a real comment opener.
      opener.lastIndex = literal.end;
      continue;
    }
    scanner.setTextPos(pos);
    const kind = scanner.scan();
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const end = scanner.getTextPos();
      ranges.push({ kind, pos, end });
      opener.lastIndex = end;
    }
  }
  return { top, ranges };
}

/** Blank comment trivia without shifting offsets or line breaks. */
export function blankTsComments(source: ts.SourceFile): string {
  const text = source.text;
  if (!hasCommentOpener(text)) return text;
  let code = "";
  let end = 0;
  for (const comment of scanTsComments(source).ranges) {
    code += text.slice(end, comment.pos);
    code += text.slice(comment.pos, comment.end).replace(/[^\n]/g, " ");
    end = comment.end;
  }
  return code + text.slice(end);
}
