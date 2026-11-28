// Full-screen view of one reply code block, opened by its Expand button. It
// reuses the image viewer's dialog shell and phone Back handling.
import { CLOSE_ICON } from "../icons.js";
import { viewerHistoryDismiss } from "../phone-nav.js";

export function openCodeViewer(wrap: HTMLElement, opener: HTMLElement): void {
  const pre = wrap.querySelector("pre");
  if (!pre) return;
  const dialog = document.createElement("dialog");
  dialog.className = "image-popout code-viewer";
  dialog.setAttribute("aria-label", "Code viewer");
  dialog.innerHTML = `<div class="image-popout-body">
    <header class="viewer-topbar image-popout-bar">
      <span class="files-name"></span>
      <button type="button" class="icon-btn lg" aria-label="Close code" title="Close code" autofocus>${CLOSE_ICON}</button>
    </header>
    <div class="content code-viewer-body"></div>
  </div>`;
  dialog.querySelector(".files-name")!.textContent =
    wrap.querySelector(".code-lang")?.textContent ?? "Text";
  dialog.querySelector(".code-viewer-body")!.append(pre.cloneNode(true));
  const dismiss = viewerHistoryDismiss(() => dialog.close());
  dialog
    .querySelector('[aria-label="Close code"]')!
    .addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    opener.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
}
