import * as XLSX from "xlsx";

const book = XLSX.utils.book_new();
for (const name of ["Summary", "Details"]) {
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Item", "Value"],
      [`${name} cell`, 42],
    ]),
    name,
  );
}
const limited = XLSX.utils.book_new();
for (let index = 1; index <= 31; index++)
  XLSX.utils.book_append_sheet(
    limited,
    XLSX.utils.aoa_to_sheet([[`Limited sheet ${index}`]]),
    `Sheet ${index}`,
  );
await Bun.write(
  new URL("limits.xlsx", import.meta.url),
  XLSX.write(limited, { bookType: "xlsx", type: "buffer" }),
);
for (const ext of ["xls", "ods"] as const) {
  await Bun.write(
    new URL(`preview.${ext}`, import.meta.url),
    XLSX.write(book, { bookType: ext, type: "buffer" }),
  );
}
