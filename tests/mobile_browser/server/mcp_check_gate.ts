import type { McpChecks } from "../../../src/mcp_checks";
import { jsonResponse, type Router } from "../../../src/web/router";

export function installMcpCheckGate(checks: McpChecks, router: Router) {
  let held: Promise<void> | undefined;
  let entered: Promise<void> | undefined;
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  let returnedBeforeAdmission = false;
  const start = checks.start.bind(checks);
  checks.start = async (name) => {
    if (held) {
      enter!();
      await held;
    }
    return start(name);
  };
  const route = router
    .routes()
    .find(
      (route) => route.path === "/api/settings/mcp-servers/finish-sign-in",
    )!;
  const finish = route.handler;
  Object.assign(route, {
    handler: async (...args: Parameters<typeof finish>) => {
      const response = await finish(...args);
      if (held && response.ok) returnedBeforeAdmission = true;
      return response;
    },
  });
  router.post("/__browser-test/mcp-check-admission", async (ex) => {
    const { action } = (await ex.request.json()) as { action: string };
    if (action === "hold") {
      returnedBeforeAdmission = false;
      held = new Promise((resolve) => (release = resolve));
      entered = new Promise((resolve) => (enter = resolve));
    } else if (action === "entered") {
      await entered;
    } else if (action === "release") {
      held = undefined;
      release!();
    }
    return jsonResponse({ returnedBeforeAdmission });
  });
}
