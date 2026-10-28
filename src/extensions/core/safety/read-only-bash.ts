// Read-only bash classification recognizes only a small grammar. Unknown
// syntax, expansions, redirections and command escape hatches fail closed to
// the model reviewer.

type Token =
  | { kind: "word"; value: string }
  | { kind: "op"; value: "&&" | "||" | "|" | ";" | "&" | "(" | ")" | "\n" };

const SIMPLE_READ_ONLY = new Set([
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "cut",
  "tr",
  "jq",
  "stat",
  "du",
  "df",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "pwd",
  "echo",
  "true",
  "false",
  "whoami",
  "id",
  "uname",
  "which",
  "ps",
  "free",
  "uptime",
  "cmp",
  "md5sum",
  "sha256sum",
  "column",
  "more",
  "od",
  "strings",
  "nl",
  "seq",
  "sleep",
  "test",
  "expr",
  "help",
  "cd",
  "pushd",
  "popd",
  "dirs",
  "times",
  "tac",
  "comm",
  "join",
  "paste",
  "fold",
  "fmt",
  "expand",
  "unexpand",
  "pr",
  "rev",
  "numfmt",
  "base64",
  "base32",
  "hexdump",
  "sha1sum",
  "sha512sum",
  "b2sum",
  "cksum",
  "sum",
  "groups",
  "who",
  "w",
  "users",
  "logname",
  "lscpu",
  "lsblk",
  "lsmem",
  "lspci",
  "lsusb",
  "nproc",
  "vmstat",
  "iostat",
  "mpstat",
  "pidstat",
  "numastat",
  "pmap",
  "pidof",
  "pgrep",
  "pstree",
  "lsof",
  "netstat",
  "findmnt",
  "lsmod",
  "modinfo",
  "getconf",
  "locale",
  "tty",
  "clear",
  "zcat",
  "bzcat",
  "xzcat",
  "zgrep",
  "bzgrep",
  "xzgrep",
  "zipinfo",
  "readelf",
  "size",
  "addr2line",
  "c++filt",
  "squeue",
  "sacct",
  "sinfo",
  "sstat",
  "sprio",
  "sshare",
]);

function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "";
  let hasWord = false;
  const emitWord = () => {
    if (hasWord) tokens.push({ kind: "word", value: word });
    word = "";
    hasWord = false;
  };

  for (let index = 0; index < source.length; ) {
    const char = source[index]!;
    if (char === "\0" || char === "\r") return undefined;
    if (char === " " || char === "\t") {
      emitWord();
      index += 1;
      continue;
    }
    if (char === "\n") {
      emitWord();
      tokens.push({ kind: "op", value: "\n" });
      index += 1;
      continue;
    }
    if (char === "#" && !hasWord) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= source.length) return undefined;
      if (source[index + 1] === "\n") {
        index += 2;
        continue;
      }
      hasWord = true;
      word += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "'") {
      hasWord = true;
      const end = source.indexOf("'", index + 1);
      if (end < 0) return undefined;
      word += source.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      hasWord = true;
      index += 1;
      let closed = false;
      while (index < source.length) {
        const quoted = source[index]!;
        if (quoted === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (quoted === "$" || quoted === "`") return undefined;
        if (quoted === "\\") {
          if (index + 1 >= source.length) return undefined;
          const next = source[index + 1]!;
          if (next === "\n") {
            index += 2;
            continue;
          }
          // Spec: In double quotes bash removes backslashes only before these
          // chars.
          if ('$`"\\'.includes(next)) word += next;
          else word += `\\${next}`;
          index += 2;
          continue;
        }
        word += quoted;
        index += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    // Invariant: Expansions and unquoted patterns can introduce uninspected
    // commands or words; only quoted/escaped literals pass.
    if (
      char === "$" ||
      char === "`" ||
      char === "*" ||
      char === "?" ||
      char === "[" ||
      char === "]" ||
      char === "{" ||
      char === "}"
    ) {
      return undefined;
    }
    if (char === "<" || char === ">") return undefined;
    if ("&|;()".includes(char)) {
      emitWord();
      const pair = source.slice(index, index + 2);
      if (pair === "&&" || pair === "||") {
        tokens.push({ kind: "op", value: pair });
        index += 2;
      } else {
        if (pair === "|&" || pair === ";&" || pair === ";;" || pair === "&>") {
          return undefined;
        }
        tokens.push({ kind: "op", value: char as "|" | ";" | "&" | "(" | ")" });
        index += 1;
      }
      continue;
    }
    hasWord = true;
    word += char;
    index += 1;
  }
  emitWord();
  return tokens;
}

function hasOption(
  args: readonly string[],
  ...names: readonly string[]
): boolean {
  return args.some((arg) =>
    names.some((name) => {
      if (arg === name || (name.startsWith("--") && arg.startsWith(`${name}=`)))
        return true;
      // Spec: GNU/Git parsers accept unique long-option abbreviations.
      const supplied = arg.split("=", 1)[0]!;
      return (
        name.startsWith("--") &&
        supplied.length > 2 &&
        name.startsWith(supplied)
      );
    }),
  );
}

function hasShortOption(args: readonly string[], letter: string): boolean {
  return args.some(
    (arg) =>
      arg.startsWith("-") &&
      !arg.startsWith("--") &&
      arg.slice(1).includes(letter),
  );
}

function safeAssignments(
  assignments: readonly string[],
  command: string,
): boolean {
  for (const assignment of assignments) {
    const equal = assignment.indexOf("=");
    if (
      equal < 1 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignment.slice(0, equal))
    ) {
      return false;
    }
    const name = assignment.slice(0, equal).toUpperCase();
    // Invariant: Environment overrides can inject hooks, libraries or
    // executables, or launch pagers, preprocessors and external diffs.
    if (
      /(?:^|_)(?:PATH|ENV|HOME|SHELL|PAGER|EDITOR|PRELOAD|LIBRARY|OPTIONS|CONFIG)(?:_|$)/.test(
        name,
      ) ||
      /HOME$/.test(name) ||
      [
        "IFS",
        "BASHOPTS",
        "SHELLOPTS",
        "CDPATH",
        "TMPDIR",
        "TMP",
        "TEMP",
      ].includes(name) ||
      name.startsWith("LD_") ||
      name.startsWith("DYLD_") ||
      command === "python" ||
      command === "python3" ||
      (command === "git" && name.startsWith("GIT_")) ||
      ((command === "less" || command === "more") && name.startsWith("LESS"))
    ) {
      return false;
    }
  }
  return true;
}

function safeGit(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--no-pager" || arg === "--paginate") index += 1;
    else if (arg === "-C" && index + 1 < args.length) index += 2;
    else break;
  }
  const subcommand = args[index];
  if (!subcommand) return false;
  const rest = args.slice(index + 1);
  const forbidden = [
    "--ext-diff",
    "--textconv",
    "--filters",
    "--force",
    "--delete",
    "--move",
    "--copy",
    "--edit-description",
    "--set-upstream-to",
    "--unset-upstream",
    "--create-reflog",
    "--annotate",
    "--sign",
    "--verify",
  ];
  if (hasOption(rest, ...forbidden)) return false;
  // Invariant: Allowlisted readers write only through -o/--output. Reject
  // --output-directory too; blame --contents only reads an input file.
  if (
    hasShortOption(rest, "o") ||
    hasOption(rest, "--output", "--output-directory")
  )
    return false;

  if (
    new Set([
      "status",
      "log",
      "diff",
      "show",
      "rev-parse",
      "merge-base",
      "ls-files",
      "ls-tree",
      "cat-file",
      "blame",
      "describe",
      "shortlog",
      "name-rev",
      "for-each-ref",
      "count-objects",
      "cherry",
      "range-diff",
      "diff-tree",
      "diff-index",
      "diff-files",
    ]).has(subcommand)
  )
    return true;
  if (subcommand === "grep")
    return (
      !hasShortOption(rest, "O") && !hasOption(rest, "--open-files-in-pager")
    );
  if (subcommand === "remote")
    return (
      (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ||
      rest[0] === "get-url"
    );
  if (subcommand === "config") {
    const get = rest.indexOf("--get");
    return (
      get >= 0 &&
      get === rest.length - 2 &&
      rest
        .slice(0, get)
        .every((arg) =>
          ["--global", "--system", "--local", "--worktree"].includes(arg),
        )
    );
  }
  if (subcommand === "stash") return rest[0] === "list" || rest[0] === "show";
  if (subcommand === "worktree") return rest[0] === "list";
  if (subcommand === "reflog") return rest[0] === "show";
  if (subcommand === "submodule") return rest[0] === "status";
  if (subcommand === "sparse-checkout") return rest[0] === "list";
  if (subcommand === "notes") return rest[0] === "list" || rest[0] === "show";
  if (subcommand === "tag") {
    if (rest.length === 0) return true;
    if (
      ["d", "f", "a", "s", "u", "m", "v"].some((flag) =>
        hasShortOption(rest, flag),
      ) ||
      hasOption(rest, "--delete", "--force", "--annotate", "--sign")
    )
      return false;
    // Spec: Positional tag names create tags unless listing is explicit.
    return rest.some((arg) => arg === "-l" || arg === "--list");
  }
  if (subcommand === "branch") {
    if (
      hasShortOption(rest, "d") ||
      hasShortOption(rest, "D") ||
      hasShortOption(rest, "f") ||
      hasShortOption(rest, "m") ||
      hasShortOption(rest, "M") ||
      hasShortOption(rest, "c") ||
      hasShortOption(rest, "C") ||
      hasOption(rest, ...forbidden)
    )
      return false;
    // Spec: Branch with no positional name is a listing operation.
    return rest.every((arg) => arg.startsWith("-"));
  }
  return false;
}

function safeRtk(args: readonly string[]): boolean {
  let index = 0;
  while (
    index < args.length &&
    ["-v", "-vv", "-vvv", "--ultra-compact", "--skip-env"].includes(
      args[index]!,
    )
  )
    index += 1;
  const subcommand = args[index];
  if (!subcommand) return false;
  const rest = args.slice(index + 1);
  if (subcommand === "git") return safeGit(rest);
  if (subcommand === "rg") return safeCommand("rg", rest);
  if (subcommand === "grep") return safeCommand("grep", rest);
  if (subcommand === "find") return safeCommand("find", rest);
  if (subcommand === "tree") return safeCommand("tree", rest);
  if (
    ["ls", "read", "diff", "log", "deps", "env", "wc", "json", "pipe"].includes(
      subcommand,
    )
  ) {
    return true;
  }
  if (subcommand === "smart") return !hasOption(rest, "--force-download");
  return (
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "--version"
  );
}

function nonOptionCount(args: readonly string[]): number {
  let afterDoubleDash = false;
  return args.filter((arg) => {
    if (arg === "--" && !afterDoubleDash) {
      afterDoubleDash = true;
      return false;
    }
    return afterDoubleDash || !arg.startsWith("-") || arg === "-";
  }).length;
}

function safeSed(args: readonly string[]): boolean {
  if (
    hasShortOption(args, "i") ||
    hasShortOption(args, "f") ||
    hasOption(args, "--in-place", "--file")
  )
    return false;

  // Spec: GNU getopt permutes options after operands; inspect every inline -e
  // before --.
  const expressions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "-e" || arg === "--expression") {
      if (index + 1 >= args.length) return false;
      expressions.push(args[index + 1]!);
      index += 1;
    } else if (arg.startsWith("--expression=")) {
      expressions.push(arg.slice("--expression=".length));
    } else if (arg.startsWith("-e") && arg.length > 2) {
      expressions.push(arg.slice(2));
    }
  }

  if (expressions.length === 0) {
    let index = 0;
    while (index < args.length) {
      const arg = args[index]!;
      if (arg === "--") {
        index += 1;
        break;
      }
      if (arg.startsWith("--")) {
        if (
          ![
            "--quiet",
            "--silent",
            "--regexp-extended",
            "--posix",
            "--unbuffered",
            "--zero-terminated",
            "--debug",
            "--sandbox",
            "--help",
            "--version",
          ].includes(arg)
        )
          return false;
        index += 1;
      } else if (arg.startsWith("-") && arg !== "-") {
        if (!/^-[nErusz]+$/.test(arg)) return false;
        index += 1;
      } else break;
    }
    if (index >= args.length) return false;
    expressions.push(args[index]!);
  }

  // Invariant: sed e/w/W can execute or write; reject these letters anywhere in
  // inline scripts conservatively.
  return expressions.every((script) => !/[eEwW]/.test(script));
}

function safeCommand(command: string, args: readonly string[]): boolean {
  if (SIMPLE_READ_ONLY.has(command)) return true;
  if (command === "rtk") return safeRtk(args);
  if (command === "git") return safeGit(args);
  if (command === "env") return args.length === 0;
  if (command === "jobs") return !hasShortOption(args, "x");
  if (command === "wait") return !hasShortOption(args, "p");
  if (command === "umask")
    return (
      args.length === 0 ||
      (args.length === 1 && ["-S", "-p"].includes(args[0]!))
    );
  if (command === "ulimit")
    return (
      args.length === 0 ||
      (args.length === 1 && ["-a", "-Sa", "-Ha"].includes(args[0]!))
    );
  if (command === "mount") return args.length === 0;
  if (command === "kill") return args.length === 1 && args[0] === "-l";
  if (command === "printf")
    return !args.some((arg) => arg === "-v" || arg.startsWith("-v"));
  if (command === "command") return args.length >= 2 && args[0] === "-v";
  if (command === "type")
    return args.length > 0 && args.every((arg) => !arg.startsWith("-"));
  if (command === "top")
    return args.length === 2 && args[0] === "-b" && args[1] === "-n1";
  if (command === "hostname") return args.length === 0;
  if (command === "date")
    return !hasShortOption(args, "s") && !hasOption(args, "--set");
  if (command === "ss")
    return !hasShortOption(args, "K") && !hasOption(args, "--kill");
  if (command === "dmesg")
    return (
      !["c", "C", "D", "E", "n"].some((flag) => hasShortOption(args, flag)) &&
      !hasOption(
        args,
        "--clear",
        "--read-clear",
        "--console-off",
        "--console-on",
        "--console-level",
      )
    );
  if (command === "scontrol") return args[0] === "show";
  if (command === "systemctl") {
    let index = 0;
    while (
      [
        "--user",
        "--system",
        "--no-pager",
        "--no-legend",
        "--plain",
        "--all",
        "--reverse",
        "--quiet",
      ].includes(args[index] ?? "")
    )
      index += 1;
    return new Set([
      "status",
      "show",
      "is-active",
      "is-failed",
      "is-enabled",
      "list-units",
      "list-unit-files",
      "list-dependencies",
      "list-jobs",
      "get-default",
      "show-environment",
      "cat",
    ]).has(args[index] ?? "");
  }
  if (command === "rg") return !hasOption(args, "--pre", "--hostname-bin");
  if (command === "fd")
    return (
      !hasShortOption(args, "x") &&
      !hasShortOption(args, "X") &&
      !hasOption(args, "--exec", "--exec-batch")
    );
  if (command === "find")
    return !args.some((arg) =>
      /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)/.test(arg),
    );
  if (command === "sort")
    return (
      !hasShortOption(args, "o") &&
      !hasShortOption(args, "T") &&
      !hasOption(
        args,
        "--output",
        "--compress-program",
        "--temporary-directory",
      )
    );
  if (command === "uniq") return nonOptionCount(args) <= 1;
  if (command === "sed") return safeSed(args);
  if (command === "awk")
    return (
      !hasShortOption(args, "f") &&
      !hasShortOption(args, "l") &&
      !args.some((arg) => arg.startsWith("-W")) &&
      !hasOption(args, "--file", "--load", "--exec") &&
      !args.some((arg) => /system\s*\(|[>|]|@(?:include|load)/i.test(arg))
    );
  if (command === "file")
    return !hasShortOption(args, "C") && !hasOption(args, "--compile");
  if (command === "nm" || command === "objdump")
    return !hasOption(args, "--plugin");
  if (command === "tree")
    return !hasShortOption(args, "o") && !hasOption(args, "--output");
  if (command === "diff")
    return !hasShortOption(args, "o") && !hasOption(args, "--output");
  if (command === "less")
    return (
      !hasShortOption(args, "o") &&
      !hasShortOption(args, "O") &&
      !hasOption(args, "--log-file", "--LOG-FILE") &&
      !args.some((arg) => arg.startsWith("+"))
    );
  if (command === "xxd")
    return !hasShortOption(args, "r") && nonOptionCount(args) <= 1;
  return false;
}

function safeSimpleCommand(words: readonly string[]): boolean {
  let commandIndex = 0;
  while (
    commandIndex < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[commandIndex]!)
  ) {
    commandIndex += 1;
  }
  if (commandIndex >= words.length) return false;
  const command = words[commandIndex]!;
  const assignments = words.slice(0, commandIndex);
  return (
    safeAssignments(assignments, command) &&
    safeCommand(command, words.slice(commandIndex + 1))
  );
}

function parseList(
  tokens: readonly Token[],
  start: number,
  subshell: boolean,
): number | undefined {
  let index = start;
  let sawCommand = false;
  let needsCommand = true;
  let hardContinuation = false;
  let lastSoftSeparator = false;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "op" && token.value === ")") {
      if (!subshell || !sawCommand || hardContinuation) return undefined;
      return index + 1;
    }
    if (token.kind === "op" && (token.value === "\n" || token.value === ";")) {
      if (token.value === ";" && (needsCommand || lastSoftSeparator))
        return undefined;
      if (!needsCommand) needsCommand = true;
      lastSoftSeparator = true;
      index += 1;
      continue;
    }
    if (token.kind === "op" && token.value === "&") {
      if (needsCommand) return undefined;
      needsCommand = true;
      hardContinuation = false;
      lastSoftSeparator = true;
      index += 1;
      continue;
    }
    if (
      token.kind === "op" &&
      (token.value === "&&" || token.value === "||" || token.value === "|")
    ) {
      if (needsCommand) return undefined;
      needsCommand = true;
      hardContinuation = true;
      lastSoftSeparator = false;
      index += 1;
      continue;
    }
    if (!needsCommand) return undefined;

    if (token.kind === "op" && token.value === "(") {
      const after = parseList(tokens, index + 1, true);
      if (after === undefined) return undefined;
      index = after;
    } else if (token.kind === "word") {
      const words: string[] = [];
      while (index < tokens.length && tokens[index]!.kind === "word") {
        words.push((tokens[index] as { kind: "word"; value: string }).value);
        index += 1;
      }
      if (!safeSimpleCommand(words)) return undefined;
    } else {
      return undefined;
    }
    sawCommand = true;
    needsCommand = false;
    hardContinuation = false;
    lastSoftSeparator = false;
  }

  if (subshell || !sawCommand || hardContinuation) return undefined;
  return index;
}

// Accept only statically parsed, allowlisted read-only simple commands.
export function isReadOnlyBashCommand(source: string): boolean {
  if (typeof source !== "string" || source.trim() === "") return false;
  const tokens = tokenize(source);
  return tokens !== undefined && parseList(tokens, 0, false) === tokens.length;
}
