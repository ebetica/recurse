// Pure formatting and URL helpers for agent-attached file controls. The URL is
// derived only from backend-issued conversation/attachment ids; authored paths
// and Markdown never enter this boundary.

import { backendFor } from "./backends/backend.js";

export function attachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function agentAttachmentHref(
  conversationId: string,
  attachmentId: string,
): string {
  return backendFor(conversationId).url(
    `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export function agentAttachmentPreviewHref(
  conversationId: string,
  attachmentId: string,
): string {
  return `${agentAttachmentHref(conversationId, attachmentId)}/preview`;
}

type AttachmentSummary = {
  id?: string;
  name?: string;
  size?: number;
  inline_media_type?: string | null;
  unavailable?: "copied" | "missing";
};

export type AgentAttachmentView =
  | {
      kind: "image";
      id: string;
      href: string;
      previewHref: string;
      alt: string;
      previewLabel: string;
      downloadName: string;
      downloadLabel: string;
    }
  | {
      kind: "file";
      id: string;
      href: string;
      name: string;
      size: string;
      downloadName: string;
      downloadLabel: string;
    }
  | {
      kind: "unavailable";
      name: string;
      size: string;
      state: string;
    };

function downloadLabel(name: string, size: string): string {
  return `Download ${name}${size ? `, ${size}` : ""}`;
}

// Keep image metadata available to assistive technology and the download
// action, but omit the visible filename/size fields that file cards need.
export function agentAttachmentView(
  conversationId: string,
  item: AttachmentSummary,
): AgentAttachmentView {
  const name = item.name || "File";
  const size = item.size && item.size > 0 ? attachmentSize(item.size) : "";
  if (!item.id || item.unavailable) {
    return {
      kind: "unavailable",
      name,
      size,
      state: attachmentUnavailableLabel(item.unavailable),
    };
  }
  const href = agentAttachmentHref(conversationId, item.id);
  if (item.inline_media_type) {
    const alt = item.name || "Attached image";
    return {
      kind: "image",
      id: item.id,
      href,
      previewHref: agentAttachmentPreviewHref(conversationId, item.id),
      alt,
      previewLabel: `Open ${alt}`,
      downloadName: item.name || "download",
      downloadLabel: downloadLabel(item.name || "image", size),
    };
  }
  return {
    kind: "file",
    id: item.id,
    href,
    name,
    size,
    downloadName: item.name || "download",
    downloadLabel: downloadLabel(item.name || "file", size),
  };
}

export function agentAttachmentLayout(items: AttachmentSummary[]): string {
  const images = items.filter(
    (item) => !!item.id && !item.unavailable && !!item.inline_media_type,
  ).length;
  if (images === 1) return "images-one";
  if (images === 2) return "images-two";
  if (images > 2) return "images-many";
  return "images-none";
}

export function attachmentUnavailableLabel(
  reason: AttachmentSummary["unavailable"],
): string {
  return reason === "copied"
    ? "Unavailable in copied conversation"
    : "File unavailable";
}

export function attachmentPreview(
  items: AttachmentSummary[] | undefined,
): string {
  if (!items?.length) return "";
  const available = items.filter((item) => item.id && !item.unavailable);
  if (available.length === 1)
    return `Attached file: ${available[0].name || "File"}`;
  if (available.length > 1) return `${available.length} attached files`;
  return "Attached file unavailable";
}
