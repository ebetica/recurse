import { expect, test } from "bun:test";
import {
  AttachmentError,
  displayName,
  inlineRasterMediaType,
} from "../../src/agents/runtime/attachments/base";

test("display names and raster magic remain validated", () => {
  expect(displayName(" folder/report.txt ")).toBe("report.txt");
  expect(() => displayName(".")).toThrow(AttachmentError);
  expect(
    inlineRasterMediaType(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
  ).toBe("image/png");
});
