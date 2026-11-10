// Library-backed document conversion in a disposable, time-limited worker.
// Archives are expanded with allocation caps and repacked before any parser;
// the inert worker DOM cannot fetch images or execute notebook/document code.
import type { DocumentPreview, DocumentSection } from "./document-preview.js";

const MAX_INPUT = 8 * 1024 * 1024;
const MAX_EXPANDED = 24 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const ROWS = 200;
const COLS = 30;

async function archive(data: Uint8Array): Promise<Uint8Array> {
  const { unzipSync, zipSync } = await import("fflate");
  let total = 0;
  let entries = 0;
  const files = unzipSync(data, {
    filter: (entry) => {
      total += Math.max(entry.originalSize, entry.size);
      if (
        ++entries > 500 ||
        total > MAX_EXPANDED ||
        entry.originalSize > MAX_INPUT ||
        entry.name === "__proto__"
      )
        throw Error("This document expands beyond the preview limit.");
      return true;
    },
  });
  return zipSync(files, { level: 0 });
}

async function docx(data: Uint8Array): Promise<DocumentPreview> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  let imageBytes = 0;
  const result = await mammoth.convertToHtml(
    { arrayBuffer: data.buffer as ArrayBuffer },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(image.contentType))
          return { src: "" };
        const base64 = await image.readAsBase64String();
        imageBytes += base64.length;
        if (base64.length > 1_400_000 || imageBytes > MAX_OUTPUT)
          throw Error("Image preview limit exceeded.");
        return { src: `data:${image.contentType};base64,${base64}` };
      }),
      transformDocument: (document) => {
        const pending = [document];
        let nodes = 0;
        while (pending.length) {
          const node = pending.pop();
          if (++nodes > 20_000)
            throw Error("This document expands beyond the preview limit.");
          if (Array.isArray(node.children)) pending.push(...node.children);
        }
        return document;
      },
    },
  );
  return { sections: [{ title: "Document", html: result.value }] };
}

async function sheets(data: Uint8Array): Promise<DocumentPreview> {
  const XLSX = await import("xlsx");
  const metadata = XLSX.read(data, { type: "array", bookSheets: true });
  const names = metadata.SheetNames.slice(0, 20);
  const book = XLSX.read(data, {
    type: "array",
    sheets: names,
    sheetRows: ROWS,
    dense: true,
    cellHTML: false,
    cellFormula: false,
    bookVBA: false,
  });
  let characters = 0;
  const sections = names.map((name): DocumentSection => {
    const rows = XLSX.utils
      .sheet_to_json<unknown[]>(book.Sheets[name]!, {
        header: 1,
        raw: true,
        range: { s: { r: 0, c: 0 }, e: { r: ROWS - 1, c: COLS - 1 } },
      })
      .map((row) =>
        row.slice(0, COLS).map((cell) => {
          const value =
            typeof cell === "string" && cell.length > 500
              ? `${cell.slice(0, 499)}…`
              : cell;
          characters += String(value).length;
          if (characters > MAX_OUTPUT / 2)
            throw Error("This document expands beyond the preview limit.");
          return value;
        }),
      );
    const sheet = book.Sheets[name]!;
    const range = XLSX.utils.decode_range(
      sheet["!fullref"] ||
        metadata.Sheets?.[name]?.["!ref"] ||
        sheet["!ref"] ||
        "A1",
    );
    return {
      title: name,
      html: XLSX.utils.sheet_to_html(XLSX.utils.aoa_to_sheet(rows), {
        editable: false,
      }),
      note:
        [
          range.e.r >= ROWS
            ? `Showing the first ${ROWS} of ${(range.e.r + 1).toLocaleString("en-US")} rows.`
            : "",
          range.e.c >= COLS
            ? `Showing the first ${COLS} of ${(range.e.c + 1).toLocaleString("en-US")} columns.`
            : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    };
  });
  return {
    sections,
    note:
      metadata.SheetNames.length > names.length
        ? `Showing ${names.length} of ${metadata.SheetNames.length.toLocaleString("en-US")} sheets.`
        : undefined,
  };
}

async function workerDocument(): Promise<void> {
  const { parseHTML } = await import("linkedom/worker");
  const { document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { window: globalThis, document });
}

async function slides(data: Uint8Array): Promise<DocumentPreview> {
  await workerDocument();
  const { parse } = await import("pptxtojson");
  const presentation = await parse(data.buffer as ArrayBuffer, {
    imageMode: "base64",
    videoMode: "none",
    audioMode: "none",
  });
  const elements = (items: any[]): string =>
    items
      .map((item) => {
        if (item.type === "group") return elements(item.elements || []);
        const image =
          item.type === "image" ? item.base64 || item.src : undefined;
        return typeof image === "string" &&
          /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(image)
          ? `<img alt="Slide image" src="${image}">`
          : typeof item.content === "string"
            ? item.content
            : "";
      })
      .join("");
  return {
    sections: presentation.slides
      .slice(0, 100)
      .map((slide: any, index: number) => ({
        title: `Slide ${index + 1}`,
        html: `<h2>Slide ${index + 1}</h2>${elements(slide.elements || [])}`,
      })),
    note: `Slide layout isn't shown.${presentation.slides.length > 100 ? ` Showing 100 of ${presentation.slides.length.toLocaleString("en-US")} slides.` : ""}`,
  };
}

async function notebook(data: Uint8Array): Promise<DocumentPreview> {
  const book = JSON.parse(new TextDecoder().decode(data));
  if (!Array.isArray(book.cells)) throw Error("Invalid notebook.");
  // Invariant: notebookjs cannot switch to unbounded legacy worksheets.
  delete book.worksheets;
  const cellCount = book.cells.length;
  book.cells = book.cells.slice(0, 200);
  const outputCounts = book.cells.map((cell: any) =>
    Array.isArray(cell.outputs) ? cell.outputs.length : 0,
  );
  for (const cell of book.cells)
    if (Array.isArray(cell.outputs)) cell.outputs = cell.outputs.slice(0, 50);
  await workerDocument();
  const { marked } = await import("marked");
  Object.assign(globalThis, { marked });
  const libraryUrl = "/static/notebook.js";
  await import(libraryUrl);
  const nb = (globalThis as any).nb;
  nb.executeJavaScript = false;
  nb.sanitizer = (html: string) => html;
  const notebook = nb.parse(book);
  const rendered = notebook.render();
  notebook.worksheets[0].cells.forEach((cell: any, index: number) => {
    if (outputCounts[index] <= 50) return;
    const note = document.createElement("p");
    note.textContent = `Showing 50 of ${outputCounts[index].toLocaleString("en-US")} outputs.`;
    cell.el.appendChild(note);
  });
  return {
    sections: [{ title: "Notebook", html: rendered.outerHTML }],
    note:
      cellCount > 200
        ? `Showing 200 of ${cellCount.toLocaleString("en-US")} cells.`
        : undefined,
  };
}

self.onmessage = async (
  event: MessageEvent<{ bytes: ArrayBuffer; name: string }>,
) => {
  try {
    let data: Uint8Array = new Uint8Array(event.data.bytes);
    if (data.length > MAX_INPUT)
      throw Error("This file is too large to preview.");
    const ext = event.data.name.split(".").pop()?.toLowerCase();
    if (
      (data[0] === 0x50 && data[1] === 0x4b) ||
      ["docx", "pptx", "xlsx", "ods"].includes(ext || "")
    )
      data = await archive(data);
    const result =
      ext === "docx"
        ? await docx(data)
        : ext === "pptx"
          ? await slides(data)
          : ext === "ipynb"
            ? await notebook(data)
            : await sheets(data);
    const html = result.sections.map((section) => section.html).join("");
    if (!result.sections.length) throw Error("No previewable content.");
    if (html.length > MAX_OUTPUT || (html.match(/</g)?.length || 0) > 40_000)
      throw Error("This document expands beyond the preview limit.");
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? error.message.slice(0, 300)
          : "Couldn’t read this document.",
    });
  }
};
