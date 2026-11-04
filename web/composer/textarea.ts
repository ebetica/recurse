/** Grow a composer field up to its scrollable height limit. */
export function resizeTextarea(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = Math.min(field.scrollHeight, 180) + "px";
}
