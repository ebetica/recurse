#!/usr/bin/env bun
/** Stable theme hooks and security markers must remain in their UI owners. */
export {};
const hooks: Record<string, string[]> = {
  "web/dom.ts": [
    "background",
    "sidebar",
    "chat-header",
    "thread",
    "composer",
    "input",
    "button",
  ],
  "web/sidebar.ts": ["sidebar-row"],
  "web/thread-render.ts": ["user-message", "assistant-message"],
  "web/settings/layout.ts": ["button", "dialog"],
  "web/panes.ts": ["pane"],
};
const protectedSurfaces: Record<string, string[]> = {
  "web/explorer.ts": ["file-destination", "model-file-warning"],
  "web/settings/auth.ts": ["provider-sign-in"],
  "web/settings/backends.ts": ["remote-sign-in"],
  "web/settings/mcp.ts": ["service-sign-in"],
  "web/settings.ts": ["change-password"],
  "web/settings/two-factor.ts": ["two-factor-sign-in"],
  "web/side-pane.ts": ["embedded-side"],
  "web/conversation/chrome.ts": ["safety-warning"],
  "web/sidebar.ts": ["safety-warning"],
  "web/thread-render.ts": ["safety-notice", "safety-denial", "reply-error"],
  "web/thread-render/refused.ts": ["reply-refusal"],
  "web/tool_details.ts": ["tool-error"],
};
let failures = 0;
for (const [file, names] of Object.entries(hooks)) {
  const source = await Bun.file(file).text();
  for (const name of names) {
    const hook = new RegExp(
      `(?:data-theme=["']${name}["']|\\.dataset\\.theme\\s*=\\s*["']${name}["'])`,
    );
    if (hook.test(source)) continue;
    console.error(`${file}: missing stable data-theme="${name}" hook`);
    failures++;
  }
}
for (const [file, names] of Object.entries(protectedSurfaces)) {
  const source = await Bun.file(file).text();
  for (const name of names) {
    const marker = new RegExp(
      `(?:data-theme-protected|\\.dataset\\.themeProtected)\\s*=\\s*(?:["']${name}["']|\\$\\{[^}]*["']${name}["'])`,
    );
    if (marker.test(source)) continue;
    console.error(`${file}: missing protected theme surface "${name}"`);
    failures++;
  }
}
console.log(`theme hooks check: ${failures} missing hooks or security markers`);
if (failures) process.exitCode = 1;
