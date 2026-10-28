import { expect } from "bun:test";
import { waitForLayout } from "./common";

export async function seedRevealThread(page: any, base: string): Promise<void> {
  const response = await page.request.post(
    `${base}__browser-test/seed-reveal-backfill`,
  );
  const seeded = await response.json();
  let seededTree = false;
  for (let attempt = 0; attempt < 30 && !seededTree; attempt++) {
    const tree = await page.request.get(`${base}api/tree`);
    if (tree.ok())
      seededTree = (await tree.json()).some(
        (node: { id?: string }) => node.id === seeded.agent,
      );
    // test-check-allow: T6 Bounded native tree poll before navigation.
    if (!seededTree) await page.waitForTimeout(100);
  }
  expect(seededTree).toBe(true);
  await page.goto(`${base}#agent=${seeded.agent}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator("#messages")
    .filter({ hasText: "pads the running tail" })
    .waitFor();
  await waitForLayout(page);
}
