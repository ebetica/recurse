import { PI_PACKAGE_ROOT } from "../../../src/build_dir";
import { run as turn } from "./models_json_turn";
import { run as review } from "./models_json_review";
import { run as selection } from "./models_json_selection";

type Request = { env: Record<string, string> } & (
  | { fixture: "auth"; input: unknown }
  | { fixture: "turn"; input: Parameters<typeof turn>[0] }
  | { fixture: "review"; input: Parameters<typeof review>[0] }
  | { fixture: "selection"; input: Parameters<typeof selection>[0] }
);
await import(PI_PACKAGE_ROOT);
let sequence = 0;
process.on("message", async (message: Request) => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, message.env);
  process.exitCode = 0;
  try {
    switch (message.fixture) {
      case "auth":
        await import(`../../../src/pi_auth.worker.mjs?case=${sequence++}`);
        break;
      case "turn":
        await turn(message.input);
        break;
      case "review":
        await review(message.input);
        break;
      case "selection":
        await selection(message.input);
        break;
    }
    const marker = `\nMODELS_JSON_DONE=${Number(process.exitCode)}\n`;
    process.stdout.write(marker);
    process.stderr.write(marker);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
process.send!("ready");
