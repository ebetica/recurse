// Shared asset publication for package scripts and native frontend staging.
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

/** Copy browser assets under their public names and assemble the shell CSS. */
export async function copyFrontendAssets(
  codeDir: string,
  outputDir: string,
): Promise<void> {
  const webDir = join(codeDir, "web");
  await mkdir(outputDir, { recursive: true });
  await cp(join(webDir, "brand"), join(outputDir, "brand"), {
    recursive: true,
  });
  for (const name of await readdir(webDir))
    if (name.endsWith(".css"))
      await copyFile(join(webDir, name), join(outputDir, name));
  for (const [source, publicName] of [
    ["diff/style.css", "diff.css"],
    ["files/style.css", "files.css"],
    ["panes/powerbar.css", "pane-powerbar.css"],
  ] as const)
    await copyFile(join(webDir, source), join(outputDir, publicName));
  await writeFile(
    join(outputDir, "app.css"),
    (await readFile(join(webDir, "theme.css"), "utf8")) +
      (await readFile(join(webDir, "panes/powerbar.css"), "utf8")) +
      (await readFile(join(webDir, "app.css"), "utf8")),
  );
  const katex = join(codeDir, "node_modules", "katex", "dist");
  await copyFile(join(katex, "katex.min.css"), join(outputDir, "katex.css"));
  await rm(join(outputDir, "fonts"), { recursive: true, force: true });
  await cp(join(katex, "fonts"), join(outputDir, "fonts"), { recursive: true });
  // Invariant: The drawing editor loads its stylesheet and every font from
  // here; a missing font would otherwise fall back to a CDN.
  const excalidraw = join(
    codeDir,
    "node_modules",
    "@excalidraw",
    "excalidraw",
    "dist",
    "prod",
  );
  await rm(join(outputDir, "excalidraw"), { recursive: true, force: true });
  await mkdir(join(outputDir, "excalidraw"));
  await copyFile(
    join(excalidraw, "index.css"),
    join(outputDir, "excalidraw", "index.css"),
  );
  await cp(join(excalidraw, "fonts"), join(outputDir, "excalidraw", "fonts"), {
    recursive: true,
  });
  const pdfjs = join(codeDir, "node_modules", "pdfjs-dist");
  await rm(join(outputDir, "pdfjs"), { recursive: true, force: true });
  await mkdir(join(outputDir, "pdfjs"));
  await copyFile(
    join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"),
    join(outputDir, "pdfjs", "pdf.worker.js"),
  );
  // Invariant: Publish PDF rendering data, never the QuickJS scripting engine.
  for (const name of ["cmaps", "standard_fonts", "iccs", "wasm"])
    await cp(join(pdfjs, name), join(outputDir, "pdfjs", name), {
      recursive: true,
      filter: (path) => !basename(path).startsWith("quickjs-"),
    });
}

if (import.meta.main)
  await copyFrontendAssets(process.cwd(), join(process.cwd(), "web", "dist"));
