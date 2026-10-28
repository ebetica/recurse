// Phone app and pane bars reveal together on a short upward scroll. Sticky
// pane headers keep their flow space, so revealing never shifts the content.
export function installPaneChrome(panes: HTMLElement): void {
  const mobile = matchMedia("(max-width: 700px)");
  let scroller: HTMLElement | null = null;
  let last = 0;
  let travel = 0;
  const reset = () => {
    document.body.classList.remove("pane-chrome-hidden");
    scroller = panes.querySelector<HTMLElement>(".pane-col.mobile-active");
    last = scroller?.scrollTop ?? 0;
    travel = 0;
  };
  panes.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (
        !mobile.matches ||
        !(target instanceof HTMLElement) ||
        !target.matches(".pane-col") ||
        !target.closest(".mobile-active")
      )
        return;
      const top = Math.max(0, target.scrollTop);
      if (target !== scroller) {
        scroller = target;
        last = 0;
        travel = 0;
      }
      const delta = top - last;
      last = top;
      if (top < 2) {
        reset();
        return;
      }
      if (!delta) return;
      travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
      if (Math.abs(travel) < 12) return;
      document.body.classList.toggle("pane-chrome-hidden", travel > 0);
      travel = 0;
    },
    true,
  );
  new MutationObserver(reset).observe(panes, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
  });
  mobile.addEventListener("change", reset);
  panes.addEventListener("focusin", (event) => {
    if ((event.target as Element).closest(".pane-powerbar"))
      document.body.classList.remove("pane-chrome-hidden");
  });
}
