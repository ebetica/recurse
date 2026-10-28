/**
 * Test policy: --strict fails all findings; --strict=T8,T9 selects fatal rules.
 * Usage: bun tests/checks/test_check.ts --help
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import ts from "typescript";
import type { Violation } from "./comment_check";

export function checkTests(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  const comments = new Map<number, ts.CommentRange>();
  const constants = new Set<string>();
  const collect = (node: ts.Node) => {
    nodes.push(node);
    for (const pos of [node.pos, node.end])
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, pos) ?? []),
      ])
        comments.set(range.pos, range);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          const original = (binding.propertyName ?? binding.name).text;
          if (
            /^[A-Z][A-Z0-9_]*$/.test(original) &&
            !/(?:^|\/)tests?\/|\.test\./.test(node.moduleSpecifier.text)
          )
            constants.add(binding.name.text);
        }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const line = (pos: number) => source.getLineAndCharacterOfPosition(pos).line;
  const exemptions = [...comments.values()].flatMap((range) => {
    const match = text
      .slice(range.pos, range.end)
      .match(/^\/\/ test-check-allow: (T[1-46-9]|T10) \S[^\r\n]*$/);
    return match ? [{ line: line(range.pos), rule: match[1] }] : [];
  });
  const findings: Violation[] = [];
  const add = (pos: number, rule: string, reason: string) => {
    const index = line(pos);
    if (
      exemptions.some(
        (e) => e.rule === rule && (e.line === index || e.line === index - 1),
      )
    )
      return;
    findings.push({ file, line: index + 1, rule, reason });
  };
  const code = (node: ts.Node | undefined) => node?.getText(source) ?? "";
  const repoPath = (path: string) =>
    !/(?:^|\/)web\/dist\//.test(path) &&
    /(?:^|\/)(?:src\/|web\/|tools\/|scripts\/|(?:tests\/)?(?:checks|dev)\/)|\.(?:css|sh)$/.test(
      path,
    );
  const sourcePath = (node: ts.Node | undefined, depth = 0): boolean => {
    if (!node || depth > 4) return false;
    if (ts.isStringLiteralLike(node)) return repoPath(node.text);
    if (
      ts.isCallExpression(node) &&
      /(?:^|\.)(?:join|resolve)$/.test(code(node.expression))
    )
      return repoPath(
        node.arguments
          .filter(ts.isStringLiteralLike)
          .map((arg) => arg.text)
          .join("/"),
      );
    return !!ts.forEachChild(
      node,
      (child) => sourcePath(child, depth + 1) || undefined,
    );
  };
  const helpCopy = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) &&
      /^(?:help(?:Output|Text|Copy|Message)?|\w+Help(?:Output|Text|Copy|Message)?|usage(?:Output|Text|Copy|Message))$/.test(
        node.text,
      )) ||
    !!ts.forEachChild(node, (child) => helpCopy(child) || undefined);
  const imported = (node: ts.Node | undefined) =>
    !!node && ts.isIdentifier(node) && constants.has(node.text);
  const literal = (node: ts.Node | undefined) =>
    !!node &&
    (ts.isLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      /^(?:true|false|null|-?\d+)$/.test(node.getText(source)));
  const functions = new Set<string>();
  for (const node of nodes) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !/(?:^|\/)(?:src|web|scripts|tools|(?:tests\/)?(?:checks|dev))\//.test(
        node.moduleSpecifier.text,
      )
    )
      continue;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) functions.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const binding of clause.namedBindings.elements)
        if (!binding.isTypeOnly) functions.add(binding.name.text);
  }
  const data = new Map<ts.Node, Map<string, ts.Expression>>();
  for (const node of nodes)
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.flags & ts.NodeFlags.Const
    )
      for (const d of node.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) {
          const scope =
            data.get(node.parent) ?? new Map<string, ts.Expression>();
          scope.set(d.name.text, d.initializer);
          data.set(node.parent, scope);
        }
  const helpers = new Map<ts.Node, Map<string, ts.FunctionDeclaration>>();
  for (const node of nodes)
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const scope =
        helpers.get(node.parent) ?? new Map<string, ts.FunctionDeclaration>();
      scope.set(node.name.text, node);
      helpers.set(node.parent, scope);
    }
  const pureCase = (
    body: ts.Node,
    parameters: readonly ts.ParameterDeclaration[] = [],
    table?: ts.Expression,
  ) => {
    const values = new Set<string>();
    const resolving = new Set<string>();
    for (const p of parameters)
      if (ts.isIdentifier(p.name)) values.add(p.name.text);
    let calls = 0,
      assertions = 0;
    const expression = (node: ts.Node): boolean => {
      if (
        literal(node) &&
        !ts.isArrayLiteralExpression(node) &&
        !ts.isObjectLiteralExpression(node)
      )
        return true;
      if (ts.isIdentifier(node)) {
        if (
          values.has(node.text) ||
          constants.has(node.text) ||
          /^(?:undefined|NaN|Infinity)$/.test(node.text)
        )
          return true;
        let initializer: ts.Expression | undefined;
        for (
          let scope: ts.Node | undefined = node.parent;
          scope;
          scope = scope.parent
        ) {
          initializer = data.get(scope)?.get(node.text);
          if (initializer) break;
        }
        if (!initializer || resolving.has(node.text)) return false;
        resolving.add(node.text);
        const valid = expression(initializer);
        resolving.delete(node.text);
        return valid;
      }
      if (ts.isBinaryExpression(node))
        return (
          !(
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ) &&
          expression(node.left) &&
          expression(node.right)
        );
      if (ts.isTemplateExpression(node))
        return node.templateSpans.every((s) => expression(s.expression));
      if (ts.isConditionalExpression(node))
        return (
          expression(node.condition) &&
          expression(node.whenTrue) &&
          expression(node.whenFalse)
        );
      if (ts.isArrowFunction(node)) {
        if (
          !node.parameters.every((p) => ts.isIdentifier(p.name)) ||
          ts.isBlock(node.body)
        )
          return false;
        const saved = new Set(values);
        for (const p of node.parameters) values.add(code(p.name));
        const valid = expression(node.body);
        values.clear();
        for (const name of saved) values.add(name);
        return valid;
      }
      if (
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isParenthesizedExpression(node)
      )
        return expression(node.expression);
      if (ts.isArrayLiteralExpression(node))
        return node.elements.every(expression);
      if (ts.isObjectLiteralExpression(node))
        return node.properties.every(
          (p) =>
            (ts.isPropertyAssignment(p) &&
              !ts.isComputedPropertyName(p.name) &&
              expression(p.initializer)) ||
            (ts.isShorthandPropertyAssignment(p) && expression(p.name)) ||
            (ts.isSpreadAssignment(p) && expression(p.expression)),
        );
      if (ts.isPropertyAccessExpression(node))
        return (
          /^Number\.(?:MAX_SAFE_INTEGER|MIN_SAFE_INTEGER|POSITIVE_INFINITY|NEGATIVE_INFINITY|NaN)$/.test(
            code(node),
          ) || expression(node.expression)
        );
      if (ts.isSpreadElement(node)) return expression(node.expression);
      if (ts.isElementAccessExpression(node))
        return (
          expression(node.expression) && expression(node.argumentExpression)
        );
      if (
        ts.isNewExpression(node) &&
        /^(?:Set|Map|URL|URLSearchParams)$/.test(code(node.expression))
      )
        return !!node.arguments && node.arguments.every(expression);
      if (ts.isPrefixUnaryExpression(node)) return expression(node.operand);
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          !functions.has(node.expression.text)
        ) {
          let helper:
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | undefined;
          for (
            let scope: ts.Node | undefined = node.parent;
            scope;
            scope = scope.parent
          ) {
            helper = helpers.get(scope)?.get(node.expression.text);
            const value = data.get(scope)?.get(node.expression.text);
            if (
              !helper &&
              value &&
              (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
            )
              helper = value;
            if (helper) break;
          }
          if (
            helper?.body &&
            !resolving.has(node.expression.text) &&
            node.arguments.every(expression)
          ) {
            const saved = new Set(values);
            resolving.add(node.expression.text);
            const validParameters = helper.parameters.every((p) => {
              if (
                !ts.isIdentifier(p.name) ||
                (p.initializer && !expression(p.initializer))
              )
                return false;
              values.add(p.name.text);
              return true;
            });
            const valid =
              validParameters &&
              (ts.isBlock(helper.body)
                ? statement(helper.body)
                : expression(helper.body));
            resolving.delete(node.expression.text);
            values.clear();
            for (const name of saved) values.add(name);
            return valid;
          }
        }
        if (
          /^(?:JSON\.(?:stringify|parse)|Object\.(?:keys|values|entries)|Array\.from|Number|String)$/.test(
            code(node.expression),
          )
        )
          return node.arguments.every(expression);
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          /^(?:repeat|join|slice|split|startsWith|endsWith|includes|map|filter|every|some|find|findIndex|at|trim|toLowerCase|toUpperCase|match|indexOf|get|has|keys|values|entries)$/.test(
            node.expression.name.text,
          )
        )
          return (
            expression(node.expression.expression) &&
            node.arguments.every(expression)
          );
        if (
          ts.isIdentifier(node.expression) &&
          functions.has(node.expression.text) &&
          node.arguments.every(expression)
        ) {
          calls++;
          return true;
        }
        if (
          code(node.expression) === "expect" &&
          node.arguments.every(expression)
        ) {
          return true;
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          /^(?:to[A-Z]\w*|not)$/.test(node.expression.name.text)
        ) {
          assertions++;
          return (
            expression(node.expression.expression) &&
            node.arguments.every(expression)
          );
        }
      }
      return false;
    };
    const statement = (node: ts.Node): boolean => {
      if (ts.isBlock(node)) return node.statements.every(statement);
      if (ts.isReturnStatement(node))
        return !!node.expression && expression(node.expression);
      if (
        ts.isForOfStatement(node) &&
        ts.isVariableDeclarationList(node.initializer) &&
        expression(node.expression)
      ) {
        const name = node.initializer.declarations[0]?.name;
        if (!name || !ts.isIdentifier(name)) return false;
        const present = values.has(name.text);
        values.add(name.text);
        const valid = statement(node.statement);
        if (!present) values.delete(name.text);
        return valid;
      }
      if (ts.isExpressionStatement(node)) return expression(node.expression);
      if (ts.isVariableStatement(node))
        return node.declarationList.declarations.every((d) => {
          if (
            !ts.isIdentifier(d.name) ||
            !d.initializer ||
            !expression(d.initializer)
          )
            return false;
          values.add(d.name.text);
          return true;
        });
      return false;
    };
    if (table && !expression(table)) return false;
    calls = 0;
    assertions = 0;
    return (
      (ts.isBlock(body) ? statement(body) : expression(body)) &&
      calls > 0 &&
      assertions > 0
    );
  };
  const isScript = /\.[cm]?[jt]sx?$/.test(file);
  for (const node of isScript ? nodes : []) {
    const pos = node.getStart(source);
    if (ts.isCallExpression(node)) {
      const call = code(node.expression);
      const table =
        ts.isCallExpression(node.expression) &&
        /^(?:test|it)\.each$/.test(code(node.expression.expression))
          ? node.expression.arguments[0]
          : undefined;
      if (
        /^(?:test|it)(?:\.(?:only|skip))?$/.test(call) ||
        (table && literal(table))
      ) {
        const callback = node.arguments[1];
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          pureCase(callback.body, table ? callback.parameters : [], table)
        )
          add(pos, "T9", "pure function on invented inputs");
      }
      if (
        (/(?:^|\.)(?:readFileSync|readFile)$/.test(call) ||
          call === "Bun.file") &&
        sourcePath(node.arguments[0])
      )
        add(pos, "T1", "reads repository source as text");
      if (call === "mock.module" || /(?:^|\.)spyOn$/.test(call))
        add(pos, "T3", "mock or spy decides the result");
      if (
        /^tests\/(?:backend|extensions)\//.test(file) &&
        /(?:^|\.)(?:spawnSync|execSync|execFileSync)$/.test(call)
      )
        add(pos, "T10", "synchronous subprocess in a test");
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const method = node.expression.name.text;
        if (
          ts.isCallExpression(receiver) &&
          code(receiver.expression) === "expect"
        ) {
          const subject = receiver.arguments[0],
            expected = node.arguments[0];
          if (/^(?:toBe|toEqual)$/.test(method)) {
            if (imported(subject) && (literal(expected) || imported(expected)))
              add(pos, "T2", "restates an imported constant");
            else if (
              subject &&
              helpCopy(subject) &&
              expected &&
              (literal(expected) ||
                /help|usage|golden|expected/i.test(code(expected)))
            )
              add(pos, "T2", "golden help or usage comparison");
          }
          if (
            /^toBeLessThan(?:OrEqual)?$/.test(method) &&
            expected &&
            ts.isNumericLiteral(expected) &&
            subject &&
            /\bms\b|Ms\b|\bp99\b|\b(?:elapsed|lag|delay|duration|max(?:Elapsed|Lag|Delay|Duration))\w*|\b(?:Date|performance)\.now\(/.test(
              code(subject),
            )
          )
            add(pos, "T6", "timing threshold");
        }
      }
      if (file.startsWith("tests/mobile_browser/")) {
        if (/(?:^|\.)waitForTimeout$/.test(call))
          add(pos, "T6", "fixed browser wait");
        if (
          /(?:^|\.)sleep$/.test(call) &&
          /^\s*\)?;?\s*expect\b/.test(text.slice(node.end))
        )
          add(pos, "T6", "sleep followed by assertion");
      }
      if (
        /^(?:test|it)(?:\.|$)/.test(call) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        /python/i.test(node.arguments[0].text)
      )
        add(pos, "T4", "test references deleted Python implementation");
    }
    if (
      ts.isAsExpression(node) &&
      /as unknown as (?:Document|Window|Element|HTML\w*Element)$/.test(
        code(node),
      )
    )
      add(pos, "T3", "fake DOM cast");
    if (
      ts.isStringLiteralLike(node) &&
      /^(?:anthropic\/|openai[^/]*\/|claude-|gpt-)/.test(node.text) &&
      /(?:^tests\/live(?:\/|_)|(?:live|provider).*\.(?:ts|js)$)/.test(file)
    )
      add(pos, "T7", "hard-coded real-provider model");
  }
  let offset = 0;
  for (const row of text.split("\n")) {
    if (/\/__modal\/|\/home\/[^/\s]+\/|\/Users\/|\/tmp\/recurse/.test(row))
      add(offset, "T5", "machine-specific path");
    if (
      isScript &&
      /^\s*\/\/ (?:Regression|Feature):/.test(row) &&
      !/^\s*\/\/ (?:Regression|Feature): #\d+ \S/.test(row)
    )
      add(offset, "T8", "test tag needs a PR number and reason");
    if (file.endsWith(".json") && /"recorded_by"\s*:\s*"[^"\n]*\.py"/.test(row))
      add(offset, "T4", "fixture recorded by deleted Python implementation");
    offset += row.length + 1;
  }
  return findings;
}

function testTitle(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (
    ts.isCallExpression(node) &&
    /^(?:test|it)(?:\.(?:skip|only|todo))?(?:\.each\([\s\S]*\))?$/.test(
      node.expression.getText(source),
    )
  ) {
    const name = node.arguments[0];
    if (name && (ts.isStringLiteralLike(name) || ts.isTemplateExpression(name)))
      return ts.isStringLiteralLike(name) ? name.text : name.getText(source);
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name?.text.startsWith("test_")
  )
    return node.name.text;
  if (
    ts.isVariableDeclaration(node) &&
    node.type?.getText(source) === "BrowserTest"
  )
    return node.name.getText(source);
  return undefined;
}

function testComments(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const cases: { start: number; end: number; title: string }[] = [];
  const comments = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node) => {
    for (const pos of [node.pos, node.end])
      for (const comment of [
        ...(ts.getLeadingCommentRanges(text, pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, pos) ?? []),
      ])
        comments.set(comment.pos, comment);
    const title = testTitle(node, source);
    if (title)
      cases.push({ start: node.getStart(source), end: node.end, title });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...comments.values()].map((comment) => {
    const owner =
      cases
        .filter((c) => c.start <= comment.pos && c.end >= comment.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0] ??
      cases
        .filter((c) => c.start >= comment.end)
        .sort((a, b) => a.start - b.start)[0];
    return {
      text: text.slice(comment.pos, comment.end),
      title: owner?.title ?? "",
      line: source.getLineAndCharacterOfPosition(comment.pos).line + 1,
    };
  });
}

/** Finds tag comments, including legacy tags inside cases or stacks. */
export function taggedTests(file: string, text: string) {
  return testComments(file, text).flatMap((comment) => {
    const tag = comment.text.match(
      /^\/\/ (Regression|Feature): #(\d+) (\S[^\r\n]*)$/,
    );
    return tag
      ? [
          {
            kind: tag[1]!.toLowerCase(),
            pr: tag[2]!,
            reason: tag[3]!,
            title: comment.title,
            line: comment.line,
          },
        ]
      : [];
  });
}

export function deletedRegressions(
  file: string,
  before: string,
  after: string,
  body: string,
): Violation[] {
  const findings: Violation[] = [];
  const source = ts.createSourceFile(file, after, ts.ScriptTarget.Latest, true);
  const titles = new Set<string>();
  const visit = (node: ts.Node) => {
    const title = testTitle(node, source);
    if (title) titles.add(title);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const tag of taggedTests(file, before)) {
    if (!tag.title || titles.has(tag.title)) continue;
    const declaration = `Removes-${tag.kind}: #${tag.pr} ${file} ${tag.title}`;
    if (
      body
        .split(/\r?\n/)
        .some(
          (row) =>
            row.startsWith(declaration) &&
            /^(?:\s|$)/.test(row.slice(declaration.length)),
        )
    )
      continue;
    findings.push({
      file,
      line: tag.line,
      rule: "T8",
      reason: `deleted ${tag.kind} #${tag.pr} ${tag.title} needs Removes-${tag.kind}`,
    });
  }
  return findings;
}

function allowances(file: string, text: string) {
  if (file === "tests/test-check-allowances.json")
    return (
      JSON.parse(text || "[]") as {
        file: string;
        rule: string;
        reason: string;
      }[]
    ).map((entry) => ({
      file: entry.file,
      test: entry.rule,
      line: 1,
      key: `json:${entry.rule} ${entry.reason}`,
    }));
  return testComments(file, text).flatMap((comment) => {
    const match = comment.text.match(/^\/\/ test-check-allow: (.+)$/);
    return match
      ? [
          {
            file,
            test: comment.title || "(file)",
            line: comment.line,
            key: `comment:${match[1]!}`,
          },
        ]
      : [];
  });
}

export function report(findings: Violation[], summary = false) {
  const counts = (key: (finding: Violation) => string) => {
    const result = new Map<string, number>();
    for (const finding of findings)
      result.set(key(finding), (result.get(key(finding)) ?? 0) + 1);
    return [...result]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
  };
  return [
    ...findings
      .slice(0, summary ? 50 : undefined)
      .map((v) => `${v.file}:${v.line} ${v.rule} ${v.reason}`),
    `Test warnings: ${findings.length}`,
    `By rule: ${counts((v) => v.rule)}`,
    `By area: ${counts((v) => v.file.split("/")[1] ?? "(root)")}`,
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  if (args.includes("--help"))
    console.log(
      "bun tests/checks/test_check.ts [--strict[=T1,T2,...]] [--summary] [--diff BASE --pr-body FILE]\n" +
        "--diff requires an exact PR-body line Test-review: PASS <full head SHA> for added or changed test-check-allow comments or allowance entries, including moved or renamed comments. The SHA must equal git HEAD and tests/ must have no uncommitted changes. The Coordinator adds this line only after an independent test reviewer passes that exact head under docs/agents/test-review.md. Old operator approval lines are not accepted. Growing tracked source files ending at 1500 or more lines also require Simplify-review: <path> <simplified|none-found|follow-up #PR> <full head SHA>, one exact line per file; see docs/agents/simplify-review.md.",
    );
  else {
    const strictFlags = args.filter(
      (arg) => arg === "--strict" || arg.startsWith("--strict="),
    );
    const strictRules = strictFlags[0]?.startsWith("--strict=")
      ? strictFlags[0].slice("--strict=".length).split(",")
      : [];
    if (
      strictFlags.length > 1 ||
      strictRules.some((rule) => !/^T(?:[1-9]|10)$/.test(rule)) ||
      new Set(strictRules).size !== strictRules.length
    )
      throw new Error(
        "Use --strict once, optionally with distinct comma-separated T1-T10 rules",
      );
    if (
      args.includes("--diff") &&
      (!flag("--diff") || !args.includes("--pr-body") || !flag("--pr-body"))
    )
      throw new Error("--diff requires BASE and --pr-body FILE");
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text(),
        error = await new Response(proc.stderr).text();
      if (await proc.exited) throw new Error(error);
      return output;
    };
    const files = (await git("ls-files", "-z", "--", "tests/"))
      .split("\0")
      .filter(Boolean);
    const findings: Violation[] = [];
    for (const file of files) {
      if (
        /^tests\/(?:checks|dev)\//.test(file) ||
        !existsSync(file) ||
        lstatSync(file).isSymbolicLink() ||
        !/\.(?:[cm]?[jt]sx?|json|txt)$/.test(file)
      )
        continue;
      findings.push(...checkTests(file, readFileSync(file, "utf8")));
    }
    const allowanceFile = "tests/test-check-allowances.json";
    if (existsSync(allowanceFile)) {
      const entries: unknown = JSON.parse(readFileSync(allowanceFile, "utf8"));
      if (!Array.isArray(entries))
        throw new Error(`${allowanceFile}: expected an array`);
      const seen = new Set<string>();
      for (const entry of entries) {
        if (
          !entry ||
          Object.keys(entry).sort().join(",") !== "file,reason,rule" ||
          typeof entry.file !== "string" ||
          !/^tests\/[^\\*?]+\.json$/.test(entry.file) ||
          entry.file
            .split("/")
            .some((part: string) => part === "." || part === "..") ||
          entry.file === allowanceFile ||
          entry.rule !== "T4" ||
          typeof entry.reason !== "string" ||
          !entry.reason.trim()
        )
          throw new Error(
            `${allowanceFile}: expected exact JSON file/T4/reason`,
          );
        if (seen.has(entry.file))
          throw new Error(`${allowanceFile}: duplicate ${entry.file}`);
        seen.add(entry.file);
        const index = findings.findIndex(
          (v) => v.file === entry.file && v.rule === entry.rule,
        );
        if (index < 0)
          throw new Error(`${allowanceFile}: stale or missing ${entry.file}`);
        for (let i = findings.length - 1; i >= 0; i--)
          if (
            findings[i]!.file === entry.file &&
            findings[i]!.rule === entry.rule
          )
            findings.splice(i, 1);
      }
    }
    if (args.includes("--diff")) {
      const base = flag("--diff")!,
        body = readFileSync(flag("--pr-body")!, "utf8");
      const newFeatures: Violation[] = [];
      const head = (await git("rev-parse", "HEAD")).trim();
      const bodyLines = body.split(/\r?\n/);
      const simplified = new Set(
        bodyLines.flatMap((line) => {
          const match = line.match(
            /^Simplify-review: (.+) (?:simplified|none-found|follow-up #[1-9]\d*) ([0-9a-f]{40})$/,
          );
          return match?.[2] === head ? [match[1]] : [];
        }),
      );
      const source =
        /\.(?:[cm]?[jt]sx?|py|sh|bash|html?|css|scss|sass|less|vue|svelte|c|h|cc|cpp|hpp|rs|go|java|rb)$/i;
      const countLines = (text: string) =>
        text.split("\n").length - Number(text.endsWith("\n") || !text);
      for (const file of (
        await git("diff", "--name-only", "-z", "--no-renames", base)
      )
        .split("\0")
        .filter(Boolean)) {
        if (
          /^(?:web\/(?:vendor|dist)|scripts\/patches)\/|(?:^|\/)fixtures\/|\.lock$/.test(
            file,
          ) ||
          !existsSync(file) ||
          lstatSync(file).isSymbolicLink()
        )
          continue;
        const text = readFileSync(file, "utf8");
        if (!source.test(file) && !text.startsWith("#!")) continue;
        const lines = countLines(text);
        if (lines < 1500 || simplified.has(file)) continue;
        const existed = (
          await git("ls-tree", "--name-only", base, "--", file)
        ).trim();
        if (
          existed &&
          lines <= countLines(await git("show", `${base}:${file}`))
        )
          continue;
        findings.push({
          file,
          line: 1,
          rule: "T8",
          reason: `growing source file (${lines} lines) needs Simplify-review: ${file} <simplified|none-found|follow-up #PR> ${head}; see docs/agents/simplify-review.md`,
        });
      }
      const reviewed =
        bodyLines.includes(`Test-review: PASS ${head}`) &&
        !(await git("diff", "--name-only", "HEAD", "--", "tests/")).trim();
      for (const file of (
        await git(
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          "--diff-filter=ADMT",
          base,
          "--",
          "tests/",
        )
      )
        .split("\0")
        .filter(Boolean)) {
        const existed = (
          await git("ls-tree", "--name-only", base, "--", file)
        ).trim();
        const before = existed ? await git("show", `${base}:${file}`) : "";
        const after = existsSync(file) ? readFileSync(file, "utf8") : "";
        const oldEntries =
          file === allowanceFile ? allowances(file, before) : [];
        const addedRanges = [
          ...(
            await git(
              "diff",
              "--text",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--unified=0",
              base,
              "--",
              file,
            )
          ).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm),
        ].map((match) => ({
          start: Number(match[1]),
          count: Number(match[2] ?? 1),
        }));
        for (const allowance of allowances(file, after)) {
          if (
            file === allowanceFile
              ? oldEntries.some(
                  (entry) =>
                    entry.file === allowance.file &&
                    entry.key === allowance.key,
                )
              : !addedRanges.some(
                  (range) =>
                    allowance.line >= range.start &&
                    allowance.line < range.start + range.count,
                )
          )
            continue;
          if (reviewed) continue;
          findings.push({
            file: allowance.file,
            line: allowance.line,
            rule: "T8",
            reason: `new test allowance for ${allowance.test}: delete the test, or prove the behaviour through an existing integration or browser test on a real path; err on the side of not adding unit tests. An independent test reviewer must pass this exact head; the Coordinator then adds Test-review: PASS ${head} to the PR body`,
          });
        }
        findings.push(...deletedRegressions(file, before, after, body));
        const oldTags = taggedTests(file, before);
        for (const tag of taggedTests(file, after))
          if (
            tag.kind === "feature" &&
            !oldTags.some((old) => old.pr === tag.pr && old.title === tag.title)
          )
            newFeatures.push({
              file,
              line: tag.line,
              rule: "T8",
              reason: "a PR may add at most one new Feature tag",
            });
      }
      if (newFeatures.length > 1) findings.push(...newFeatures);
    }
    console.log(report(findings, args.includes("--summary")));
    if (
      (args.includes("--strict") && findings.length) ||
      findings.some(
        (v) =>
          strictRules.includes(v.rule) ||
          (v.rule === "T8" &&
            /^(?:deleted |a PR may add|new test allowance|growing source file)/.test(
              v.reason,
            )),
      )
    )
      process.exitCode = 1;
  }
}
