// Text hash shared by the view server and the web client. A text-delta row
// names the hash of the prefix it extends, so the client appends only to the
// exact text the server measured against, whatever order reads land in.

/** 32-bit FNV-1a over the UTF-16 code units of `text`, unsigned. */
export function textHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
