// Authored image references stay inert until classified. Local paths use the
// operator-only, byte-sniffed route; web images require a click per image and
// send no referrer. Small raster data URLs need no network permission.
import { backendFor, parseConversationId } from "../backends/backend.js";
import type { SessionFile } from "../files/model.js";

const PATH_IMAGE_ROUTE =
  /^\/api(?:\/backends\/[A-Za-z0-9._-]{1,32})?\/conversations\/[^/]+\/path-image$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export function imageHost(source: string | null): string | null {
  try {
    const url = new URL(source || "");
    return ["http:", "https:"].includes(url.protocol) ? url.host : null;
  } catch {
    return null;
  }
}

export function referenceImageUrl(
  source: string | null,
  cid: string | null,
  documentPath?: string,
  artifact?: string,
): string | null {
  if (!source) return null;
  if (source.length <= 256 * 1024 && DATA_IMAGE.test(source)) return source;
  if (
    !cid ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source) ||
    source.length > 4096
  )
    return null;
  let path: string;
  try {
    path = decodeURIComponent(source);
  } catch {
    return null;
  }
  const query = new URLSearchParams({ path, thumbnail: "1" });
  if (documentPath) query.set("document", documentPath);
  if (artifact) query.set("artifact", artifact);
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(parseConversationId(cid).cid)}/path-image?${query}`,
  );
}

export function originalPathImage(source: string): string | null {
  const url = new URL(source, location.href);
  if (url.origin !== location.origin || !PATH_IMAGE_ROUTE.test(url.pathname))
    return null;
  url.searchParams.delete("thumbnail");
  return url.pathname + url.search;
}

export function externalImageButton(
  source: string,
  alt: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn sm external-image";
  button.dataset.externalImage = source;
  button.dataset.imageAlt = alt;
  button.textContent = `Show image from ${imageHost(source)}`;
  return button;
}

export function imageFailure(source: string): HTMLElement {
  const failed = document.createElement("span");
  failed.className = "artifact-blocked-image artifact-failed-image";
  const label = source.startsWith("data:")
    ? "inline data image"
    : source || "unknown path";
  failed.textContent = `Image not found: ${label.length > 180 ? label.slice(0, 180) + "…" : label}`;
  failed.title = label;
  failed.style.overflowWrap = "anywhere";
  failed.style.maxWidth = "100%";
  return failed;
}

/** Share the Files viewer for validated local references and thread uploads. */
export function installReferenceImageViewer(
  selected: () => string | null,
  open: (cid: string, file: SessionFile) => void,
  attachment: (cid: string, id: string) => unknown,
): void {
  document.addEventListener("click", (event) => {
    const image = (event.target as Element).closest?.("img");
    const cid = selected();
    if (!image || !cid || image.closest("button, a")) return;
    const path = originalPathImage(
      image.dataset.pathImage || image.getAttribute("src") || "",
    );
    if (path) {
      const name =
        new URL(path, location.href).searchParams
          .get("path")
          ?.split("/")
          .pop() ||
        image.alt ||
        "Image";
      open(cid, {
        key: path,
        image_url: path,
        storage: "published",
        name,
        size: 0,
        media_type: "application/octet-stream",
        preview: "image",
        references: 1,
        sources: [],
      });
      return;
    }
    const match =
      /^\/api(?:\/backends\/([^/]+))?\/conversations\/([^/]+)\/attachments\/([^/]+)\/(?:preview|thumbnail)$/.exec(
        image.getAttribute("src") || "",
      );
    const owner = match && (match[1] ? `${match[1]}/${match[2]}` : match[2]);
    if (image.closest("#messages") && owner === cid)
      attachment(cid, match![3]!);
  });
}

/** Only an explicit click grants a single authored web image a network load. */
export function showExternalImage(event: Event): void {
  const button = (event.target as Element).closest?.<HTMLButtonElement>(
    "button.external-image",
  );
  const source = button?.dataset.externalImage;
  if (!button || !source || !imageHost(source)) return;
  event.preventDefault();
  const image = document.createElement("img");
  image.alt = button.dataset.imageAlt || "Image";
  image.referrerPolicy = "no-referrer";
  image.decoding = "async";
  image.style.cssText =
    "display:block;max-width:100%;max-height:360px;width:auto;height:auto";
  image.addEventListener(
    "error",
    () => image.replaceWith(imageFailure(source)),
    {
      once: true,
    },
  );
  button.replaceWith(image);
  image.src = source;
}
