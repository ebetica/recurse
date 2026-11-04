// Deliberate real rename while a native SQLite reader stays open.
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openFauxHarness } from "../backend/fixtures/durable_sqlite/harness";
import { SqliteWorker } from "../../src/agents/durable/sqlite_worker";
import { MessageSearch } from "../../src/search";
import { tla } from "./rotation_record";

const dir = process.argv[2]!;
mkdirSync(dir, { recursive: true });
const path = join(dir, "session.sqlite");
const owner = new SqliteWorker();
const writer = await owner.openDatabase(path);
const { harness } = await openFauxHarness(writer);
await harness.close(context);
const search = new MessageSearch();
await search.sync({ cid: "bug", path });
await search.close();
const reader = await owner.openDatabase(path, undefined, undefined, true, true);
await reader.get("SELECT count(*) FROM entries");
tla("fence", { p: path, k: "page" });
tla("rename", { paths: [path] });
renameSync(path, join(dir, "moved.sqlite"));
await reader.close();
await owner.close();
