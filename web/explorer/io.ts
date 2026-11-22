// Working-folder paths and reads shared by the browser, viewer and file tabs.
import { backendFor } from "../backends/index.js";

export function absolutePath(root: string, path: string): string {
  return `${root.replace(/\/$/, "")}/${path}`;
}

export function endpoint(
  cid: string,
  suffix = "",
  query: Record<string, string> = {},
): string {
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/tree${suffix}?${new URLSearchParams(query)}`,
  );
}
export async function read<T>(
  cid: string,
  url: string,
  signal: AbortSignal,
): Promise<T> {
  const { response, data } = await backendFor(cid).apiJson<T>(url, { signal });
  if (!response.ok)
    throw new Error(
      String(
        (data as { detail?: string }).detail ||
          "Could not load files; try again.",
      ),
    );
  return data;
}
