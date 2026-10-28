export interface DownloadRequest {
  url: string;
  filename: string;
}

type ClickIntent = Pick<
  MouseEvent,
  "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>;

interface DownloadLink {
  href: string;
  download: string;
  dataset?: { bytes?: string };
}

// Files above this size use browser downloads with native progress.
export const NATIVE_DOWNLOAD_MIN_BYTES = 4 * 1024 * 1024;

export function downloadRequest(
  click: ClickIntent,
  link: DownloadLink | null,
  origin: string,
): DownloadRequest | null {
  if (
    !link ||
    click.button !== 0 ||
    click.ctrlKey ||
    click.metaKey ||
    click.shiftKey ||
    click.altKey ||
    Number(link.dataset?.bytes) > NATIVE_DOWNLOAD_MIN_BYTES
  )
    return null;
  const url = new URL(link.href, origin);
  return url.origin === origin
    ? { url: url.href, filename: link.download }
    : null;
}

interface DownloadActions {
  fetch: (url: string) => Promise<Pick<Response, "ok" | "blob" | "headers">>;
  save: (blob: Blob, filename: string) => void;
  fallback: () => void;
}

function responseFilename(response: Pick<Response, "headers">): string {
  const value = response.headers.get("Content-Disposition") || "";
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {}
  }
  return /filename="([^"]+)"/i.exec(value)?.[1] || "";
}

export async function performDownload(
  request: DownloadRequest,
  actions: DownloadActions,
): Promise<void> {
  try {
    const response = await actions.fetch(request.url);
    if (!response.ok) throw new Error("download failed");
    actions.save(
      await response.blob(),
      request.filename || responseFilename(response),
    );
  } catch {
    actions.fallback();
  }
}

export function handleDownloadClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[download]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const request = downloadRequest(event, anchor, window.location.origin);
  if (!request) return;

  event.preventDefault();
  void performDownload(request, {
    fetch: (url) => fetch(url, { credentials: "same-origin" }),
    save: (blob, filename) => {
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    },
    fallback: () => {
      const link = document.createElement("a");
      link.href = anchor.href;
      link.download = anchor.download;
      link.click();
    },
  });
}
