// Frame policy and document-local IDs shared by document previews.
import { ARTIFACT_KEY_RELAY } from "../../src/artifacts/index.js";

let frameDescriptionSequence = 0;

export function nextArtifactFrameDescriptionId(): string {
  frameDescriptionSequence += 1;
  return `artifact-frame-description-${frameDescriptionSequence}`;
}

// Opaque-origin sandbox CSP blocks network, navigation and embedding.
export const URL_ATTRIBUTES = new Set([
  "action",
  "archive",
  "attributionsrc",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "imagesrcset",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcdoc",
  "srcset",
  "usemap",
  "xlink:href",
]);

const STATIC_EMBED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'none'; media-src 'none'; connect-src 'none'; font-src 'none'; " +
  "frame-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'; " +
  "base-uri 'none'; form-action 'none'; navigate-to 'none'";

export function htmlPreviewSrcdoc(
  source: string,
  options?: { scripts: false; embeddedImages: true },
): string {
  const policy = options
    ? STATIC_EMBED_CSP.replace(
        "script-src 'unsafe-inline'",
        "script-src 'none'",
      )
        .replace("img-src 'none'", "img-src data:")
        .replace("; navigate-to 'none'", "")
    : STATIC_EMBED_CSP;
  // Invariant: This CSP is the first parsed element; a document cannot weaken
  // it.
  return (
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta name="color-scheme" content="dark light">` +
    `<style>html,body{margin:0;max-width:100%;overflow-wrap:anywhere}` +
    `body{box-sizing:border-box;padding:8px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}` + // font-check: allow Artifact document text, not UI; space-check: allow no theme tokens in the iframe
    `pre,table{display:block;max-width:100%;overflow:auto}</style>` +
    (options ? "" : ARTIFACT_KEY_RELAY) +
    source
  );
}
