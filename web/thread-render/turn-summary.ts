// Builds one-line activity only from closed labels, integers and PR numbers. No
// paths, commands or payloads can reach it; changed/published work comes before
// reads/runs. Pure projection; turn views render it.
import type { TurnSummary } from "../types.js";

// Active command counts belong to their visible owner; keep completed evidence.
export function summaryWithoutRunningCommands(line: string): string {
  return line
    .split(" · ")
    .map((part) =>
      part
        .split(", ")
        .filter(
          (part) => !/^(?:[Rr]unning|[Pp]reparing) \d+ commands?$/.test(part),
        )
        .join(", "),
    )
    .filter(Boolean)
    .join(" · ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

type SummaryPart =
  | { kind: "text"; value: string }
  | { kind: "prs"; values: number[] };

const count = (n: number, word: string, suffix = "s"): string =>
  `${n} ${word}${n === 1 ? "" : suffix}`;

const safeCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return 0;
  const integer = Math.floor(value);
  return Number.isSafeInteger(integer) ? integer : MAX_SAFE_COUNT;
};

const safeSum = (left: number, right: number): number =>
  left > MAX_SAFE_COUNT - right ? MAX_SAFE_COUNT : left + right;

const prPart = (prs: number[]): string =>
  prs.length
    ? `${prs.length === 1 ? "PR" : "PRs"} ${prs.map((n) => `#${n}`).join(", ")}`
    : "";

const defaultSummary: TurnSummary = {
  tools: 0,
  shell: 0,
  read_files: 0,
  edit_files: 0,
  added: 0,
  removed: 0,
  write_files: 0,
  agents: 0,
  searches: 0,
  web: 0,
  prs: [],
  truncated: false,
};

function partsFor(
  summary: TurnSummary | null | undefined,
  incomingAgentMessages: number,
  runningCommands = 0,
  preparingCommands = 0,
): SummaryPart[] {
  if (!summary && incomingAgentMessages <= 0) return [];
  const safeSummary = summary || defaultSummary;
  const incoming = safeCount(incomingAgentMessages);

  // Invariant: A turn reconstructed from a pre-transcript log has no
  // trustworthy breakdown.
  if (safeSummary.approx) {
    const tools = safeCount(safeSummary.tools);
    if (!incoming)
      return tools ? [{ kind: "text", value: count(tools, "tool use") }] : [];
    const messages = `poked ${count(incoming, "agent")}`;
    return tools
      ? [
          { kind: "text", value: count(tools, "tool use") },
          { kind: "text", value: messages },
        ]
      : [{ kind: "text", value: messages }];
  }

  const parts: SummaryPart[] = [];
  const editFiles = safeCount(safeSummary.edit_files);
  const added = safeCount(safeSummary.added);
  const removed = safeCount(safeSummary.removed);
  if (editFiles) {
    const delta = added || removed ? ` +${added} -${removed}` : "";
    parts.push({
      kind: "text",
      value: `edited ${count(editFiles, "file")}${delta}`,
    });
  }
  const writeFiles = safeCount(safeSummary.write_files);
  if (writeFiles)
    parts.push({ kind: "text", value: `wrote ${count(writeFiles, "file")}` });
  if (safeSummary.prs?.length)
    parts.push({ kind: "prs", values: safeSummary.prs });
  const readFiles = safeCount(safeSummary.read_files);
  if (readFiles)
    parts.push({ kind: "text", value: `read ${count(readFiles, "file")}` });
  const searches = safeCount(safeSummary.searches);
  if (searches)
    parts.push({
      kind: "text",
      value: `ran ${count(searches, "search", "es")}`,
    });
  const web = safeCount(safeSummary.web);
  if (web) parts.push({ kind: "text", value: count(web, "web request") });

  const created = safeCount(safeSummary.agents);
  const reaped = safeCount(safeSummary.agent_reaps);
  if (created > 0 && created === reaped) {
    parts.push({ kind: "text", value: `used ${count(created, "agent")}` });
  } else {
    if (created > 0)
      parts.push({ kind: "text", value: `created ${count(created, "agent")}` });
    if (reaped > 0)
      parts.push({ kind: "text", value: `removed ${count(reaped, "agent")}` });
  }

  const outgoing = safeCount(safeSummary.agent_messages);
  const interactions = safeSum(incoming, outgoing);
  if (interactions > 0) {
    parts.push({
      kind: "text",
      value: `poked ${count(interactions, "agent")}`,
    });
  }

  const shell = Math.max(
    0,
    safeCount(safeSummary.shell) - created - outgoing - reaped,
  );
  const running = Math.min(shell, safeCount(runningCommands));
  const preparing = Math.min(shell - running, safeCount(preparingCommands));
  if (shell > running + preparing)
    parts.push({
      kind: "text",
      value: `ran ${count(shell - running - preparing, "command")}`,
    });
  if (running)
    parts.push({ kind: "text", value: `running ${count(running, "command")}` });
  if (preparing)
    parts.push({
      kind: "text",
      value: `preparing ${count(preparing, "command")}`,
    });

  // Invariant: Bg-shell completions fold exactly like tool calls: counted here,
  // shown only inside the opened disclosure. A closed label, never command
  // text.
  const finished = safeCount(safeSummary.background_shells);
  if (finished > 0)
    parts.push({
      kind: "text",
      value: `${count(finished, "backgrounded shell")} finished`,
    });

  if (!parts.length) {
    const tools = safeCount(safeSummary.tools);
    return tools ? [{ kind: "text", value: count(tools, "tool use") }] : [];
  }
  return parts;
}

const capitalize = (line: string): string =>
  line ? line.charAt(0).toUpperCase() + line.slice(1) : line;

export function summaryLine(
  summary: TurnSummary | null | undefined,
  incomingAgentMessages = 0,
  runningCommands = 0,
  preparingCommands = 0,
): string {
  const parts = partsFor(
    summary,
    incomingAgentMessages,
    runningCommands,
    preparingCommands,
  );
  return capitalize(
    parts
      .map((part) => (part.kind === "prs" ? prPart(part.values) : part.value))
      .join(", "),
  );
}

const SAFE_PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d{1,9})\/?$/;

// URLs are carried alongside the number by the backend, but every browser
// boundary validates them again before turning one into an active link.
export function safePrUrl(number: number, url: unknown): string | null {
  if (!Number.isSafeInteger(number) || number < 0 || typeof url !== "string")
    return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.host !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null;
    const match = SAFE_PR_URL.exec(parsed.href);
    return match && Number(match[1]) === number ? parsed.href : null;
  } catch {
    return null;
  }
}

const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function summaryLineHtml(
  summary: TurnSummary | null | undefined,
  incomingAgentMessages = 0,
): string {
  const parts = partsFor(summary, incomingAgentMessages);
  if (!parts.length) return "";
  const links = summary?.pr_links || [];
  const rendered = parts.map((part, index) => {
    const prefix = index ? ", " : "";
    if (part.kind === "text")
      return `${prefix}${index ? part.value : capitalize(part.value)}`;
    const refs = part.values
      .map((number) => {
        const link = links.find((candidate) => candidate?.number === number);
        const href = safePrUrl(number, link?.url);
        return href
          ? `<a href="${htmlEscape(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open pull request #${number} on GitHub">#${number}</a>`
          : `#${number}`;
      })
      .join(", ");
    return `${prefix}${part.values.length === 1 ? "PR" : "PRs"} ${refs}`;
  });
  return rendered.join("");
}

// A turn shows a bounded number of tool rows; this accounts for the rest so the
// capped list never reads as the complete record.
export function hiddenToolNote(totalTools: number, listedRows: number): string {
  const hidden = Math.floor(totalTools) - Math.floor(listedRows);
  if (!Number.isFinite(hidden) || hidden <= 0) return "";
  return `…and ${hidden} more not listed`;
}
