/** Reserve the compact bar, freeze canvases, and follow the keyboard. */
export function installImageCommentLayout(body: HTMLElement): () => void {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let width = 0;
  let height = 0;
  const measureCompactBar = () => {
    const sidebar = body.querySelector(".image-comment-sidebar");
    if (
      sidebar?.classList.contains("comments-open") ||
      sidebar?.querySelector(".report-comment-popover:not([hidden])")
    )
      return;
    const bar = sidebar?.querySelector<HTMLElement>(".report-sendbar");
    if (!bar?.offsetHeight) return;
    body.style.setProperty(
      "--image-comment-bar-height",
      `${bar.offsetHeight}px`,
    );
    observer.disconnect();
  };
  const observer = new MutationObserver(measureCompactBar);
  const update = () => {
    if (width !== innerWidth) {
      width = innerWidth;
      height = innerHeight;
      observer.observe(body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden"],
      });
      measureCompactBar();
    }
    const viewport = visualViewport;
    const bottom = viewport
      ? viewport.offsetTop + viewport.height
      : innerHeight;
    body.style.setProperty("--image-canvas-height", `${height}px`);
    body.style.setProperty("--image-overlay-lift", `${height - bottom}px`);
    body.style.setProperty(
      "--image-visible-height",
      `${viewport?.height ?? innerHeight}px`,
    );
  };
  window.addEventListener("resize", update, options);
  visualViewport?.addEventListener("resize", update, options);
  visualViewport?.addEventListener("scroll", update, options);
  update();
  return () => {
    controller.abort();
    observer.disconnect();
  };
}
