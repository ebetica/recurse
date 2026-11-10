// Portal global desktop finders outside Chat; keep mentions and phones inline.
const homes = new WeakMap<
  HTMLElement,
  { parent: Node; next: ChildNode | null }
>();

export function placeFinder(finder: HTMLElement, global: boolean): void {
  if (!finder.parentNode) return;
  let home = homes.get(finder);
  if (!home) {
    home = { parent: finder.parentNode, next: finder.nextSibling };
    homes.set(finder, home);
  }
  const floating = global && !!document.querySelector("#panes.docked");
  const parent = floating ? document.body : home.parent;
  finder.classList.toggle("dock-finder", floating);
  if (finder.parentNode === parent) return;
  parent.insertBefore(
    finder,
    !floating && home.next?.parentNode === parent ? home.next : null,
  );
}
