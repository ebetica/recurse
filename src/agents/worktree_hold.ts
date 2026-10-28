// Claim subprocess: validate checkout and write holder under retirement lock.
import { addHolder, rootFromEnv } from "../../tools/worktree";

const { dataDir, workdir, cid } = JSON.parse(await Bun.stdin.text()) as {
  dataDir: string;
  workdir: string;
  cid: string;
};
process.stdout.write(
  `${await addHolder(rootFromEnv(dataDir), workdir, cid)}\n`,
);
