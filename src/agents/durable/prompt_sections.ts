// Request-boundary detached prompt snapshots; renderers have no clock.
// customPrompt replaces Pi defaults; context rendering derives from Pi 1.3.0.
// Omit elapsed idle ages to avoid a system delta caused by wall-clock passage.
// Resource loading is separate and uses the request cwd.

/*
 * Copyright (c) 2025 Mario Zechner, MIT.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  section,
  type PromptInput,
} from "@earendil-works/pi-durable";
import { escapeReminderMarkers } from "../../reminder_text";
import { escapeOriginMarkers } from "../runtime/prompt_stamp";
import { slowSpan } from "../../observability/slow_span";
import { type Conv, type DigestInputs, Prompts } from "../runtime/prompts";
import { systemBeforeUserHook } from "./system_order";
import type { PromptResources } from "./prompt_resources";

export interface PromptSnapshot extends PromptResources {
  foreword: string;
  recurse_agent: string;
  recurse_memory: string;
  recurse_runtime: string;
  recurse_tree: string;
  recurse_tools: string;
  /** Pi's MCP extension section (mcp.ts mcpServersSection), when set. */
  mcp_servers?: string;
}

/** Reuse today's renderers; memory is the host's already captured snapshot. */
export function snapshotRecursePrompt(
  prompts: Prompts,
  conv: Conv,
  digest: DigestInputs,
  cwd: string,
  memory: string,
  resources: PromptResources,
): PromptSnapshot {
  return slowSpan("prompt_render", String(conv.id), () => ({
    ...resources,
    foreword: prompts.foreword(),
    recurse_agent: escapeReminderMarkers(prompts.buildContextBlock(conv)),
    recurse_memory: escapeReminderMarkers(memory),
    recurse_runtime: escapeReminderMarkers(
      escapeOriginMarkers(prompts.runtimeContextBlock(conv, cwd)),
    ),
    recurse_tree: escapeReminderMarkers(
      prompts.treeDigestSnapshot(conv, digest, false),
    ),
    recurse_tools: escapeReminderMarkers(prompts.recurseToolsSection()),
  }));
}

/** Untagged values, in Pi's buildSystemPromptSections order. */
export function renderPromptSections(
  state: PromptSnapshot,
  cwd: string,
): Record<string, string> {
  return {
    preamble: state.foreword,
    ...(state.contextFiles.length
      ? {
          project_context: [
            "Project-specific instructions and guidelines:",
            ...state.contextFiles.map(
              ({ path, content }) =>
                `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
            ),
          ].join("\n\n"),
        }
      : {}),
    ...(state.skills.length
      ? { skills: formatSkillsForPrompt(state.skills, "read").trim() }
      : {}),
    cwd: cwd.replace(/\\/g, "/"),
    recurse_agent: state.recurse_agent,
    recurse_memory: state.recurse_memory,
    recurse_runtime: state.recurse_runtime,
    recurse_tree: state.recurse_tree,
    recurse_tools: state.recurse_tools,
    ...(state.mcp_servers ? { mcp_servers: state.mcp_servers } : {}),
  };
}

// The host's snapshot callback must be detached, stable, and keyed to
// input.cwd.
export function createPromptExtension(
  snapshot: (input: PromptInput) => PromptSnapshot | Promise<PromptSnapshot>,
  cid?: string,
) {
  // Invariant: Durable shares one PromptInput identity per section render pass,
  // so every section reads the same cached request-boundary snapshot.
  const passes = new WeakMap<PromptInput, Promise<Record<string, string>>>();
  const keys = [
    "preamble",
    "project_context",
    "skills",
    "cwd",
    "recurse_agent",
    "recurse_memory",
    "recurse_runtime",
    "recurse_tree",
    "recurse_tools",
    "mcp_servers",
  ];
  return defineExtension({
    name: "recurse.prompt",
    sections: keys.map((key) =>
      section(
        key,
        (input) => {
          let pass = passes.get(input);
          if (!pass) {
            const cwd = input.env?.cwd ?? input.agent.cwd;
            if (!cwd)
              throw new Error("Recurse prompt requires a working directory");
            pass = Promise.resolve(snapshot(input)).then((state) =>
              slowSpan("prompt_render", cid, () =>
                renderPromptSections(state, cwd),
              ),
            );
            passes.set(input, pass);
          }
          return pass.then((rendered) => rendered[key] || undefined);
        },
        { tag: key !== "preamble" },
      ),
    ),
    hooks: [systemBeforeUserHook],
  });
}
