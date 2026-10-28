"""Check Python docstrings and comments using Python's parser and tokenizer.

Eight physical lines leave room for a module's purpose and safety rules.
Declaration docs use at most two lines. Read a JSON file list from stdin.
"""

import ast
import io
import json
import re
import sys
import tokenize


def check(file, text, width):
    """Return comment policy findings for one source file."""
    findings = []
    lines = text.splitlines()

    def add(line, rule, reason):
        findings.append(dict(file=file, line=line, rule=rule, reason=reason))

    try:
        tree = ast.parse(text, filename=file)
        tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (SyntaxError, tokenize.TokenError) as error:
        add(1, "python-syntax", f"cannot inspect Python: {type(error).__name__}")
        return findings
    docs = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        first = node.body[0] if node.body else None
        if not (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            continue
        docs.add(id(first))
        limit = 8 if isinstance(node, ast.Module) else 2
        if first.end_lineno - first.lineno + 1 > limit:
            add(first.lineno, "comment-lines", f"docstring exceeds {limit} lines")
        for number in range(first.lineno, first.end_lineno + 1):
            if len(lines[number - 1]) > width:
                add(number, "comment-width", f"comment line exceeds print width {width}")
    for node in ast.walk(tree):
        if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str) and id(node) not in docs):
            add(node.lineno, "unexpected-comment", "standalone string is not a module or declaration docstring")
    for token in tokens:
        if token.type != tokenize.COMMENT:
            continue
        number, column = token.start
        content = token.string[1:].strip()
        pragma = re.match(
            r"(?:!|.*coding[:=]\s*[-\w.]+|type:\s*(?:ignore\b|[^#]+$)|"
            r"noqa\b|(?:pylint|ruff):|(?:fmt|yapf):|pragma:\s*no cover\b|"
            r"SPDX-License-Identifier:|Copyright\b|Licensed under\b)", content)
        if not pragma and not re.match(r"(?:Invariant:|Spec:)", content):
            add(number, "unexpected-comment", "comment must state an Invariant: or Spec:")
        if column + len(token.string) > width:
            add(number, "comment-width", f"comment line exceeds print width {width}")
    return sorted(findings, key=lambda item: (item["line"], item["rule"]))


if __name__ == "__main__":
    json.dump([finding for source in json.load(sys.stdin)
               for finding in check(**source)], sys.stdout)
