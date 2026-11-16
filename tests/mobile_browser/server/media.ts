import { deflateSync } from "node:zlib";
export const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function navigationPng(
  background: [number, number, number],
  digit: number,
  noisy = false,
): Uint8Array {
  const width = 800;
  const height = 500;
  const pixels = new Uint8Array(width * height * 3);
  let seed = digit;
  const jitter = () =>
    (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 26;
  for (let offset = 0; offset < pixels.length; offset += 3)
    pixels.set(
      noisy ? background.map((value) => value + jitter()) : background,
      offset,
    );
  const segments: Record<string, [number, number, number, number]> = {
    a: [280, 80, 520, 125],
    b: [480, 110, 525, 240],
    c: [480, 260, 525, 390],
    d: [280, 375, 520, 420],
    e: [275, 260, 320, 390],
    f: [275, 110, 320, 240],
    g: [280, 228, 520, 272],
  };
  const digits = ["abcdef", "bc", "abdeg", "abcdg"];
  for (const segment of digits[digit]) {
    const [x1, y1, x2, y2] = segments[segment];
    for (let y = y1; y < y2; y++)
      pixels.fill(255, (y * width + x1) * 3, (y * width + x2) * 3);
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    result.write(type, 4);
    result.set(data, 8);
    result.writeUInt32BE(
      Bun.hash.crc32(result.subarray(4, -4)),
      data.length + 8,
    );
    return new Uint8Array(result);
  };
  const scanlines = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines.set(
      pixels.subarray(y * width * 3, (y + 1) * width * 3),
      y * (width * 3 + 1) + 1,
    );
  }
  return new Uint8Array(
    Buffer.concat([
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk(
        "IHDR",
        Uint8Array.from([0, 0, 3, 32, 0, 0, 1, 244, 8, 2, 0, 0, 0]),
      ),
      chunk("IDAT", new Uint8Array(deflateSync(scanlines))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

export const NAVIGATION_IMAGES = [
  navigationPng([210, 55, 55], 1),
  navigationPng([40, 150, 80], 2),
  navigationPng([50, 100, 210], 3),
];

function pdfFile(objects: string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const stream = (text: string) =>
  `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;

export function rectanglePdf(pages: number): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + 2 * i} 0 R`).join(" ")}] >>`,
  ];
  for (let i = 0; i < pages; i++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${4 + 2 * i} 0 R >>`,
      stream("1 0 0 rg 50 50 200 100 re f"),
    );
  return pdfFile(objects);
}

export function japanesePdf(): Uint8Array {
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("BT /F1 24 Tf 20 90 Td <30533093306B3061306F> Tj ET"),
    "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R >>",
    "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  ]);
}

export function silentWav(): Uint8Array {
  const samples = 800;
  const out = Buffer.alloc(44 + samples, 0x80);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(8000, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples, 40);
  return new Uint8Array(out);
}
