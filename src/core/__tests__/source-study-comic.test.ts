import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KonteError } from "../errors.js";
import { pdfInfo, renderPdfPage } from "../pdf-render.js";
import { imageHeaderSize } from "../image-size.js";
import { Pdf, contentOperators } from "../pdf.js";
import { comicInfoBinding, comicPage, sheetOrder } from "../source-study-comic.js";
import { type SourceRef, refreshStudyIndex, sourceExcerpt, studySource } from "../source-study.js";

// pdf.js draws in Chromium; here a drawn page is the fixture's JPEG.
vi.mock("../pdf-render.js", () => ({
  pdfInfo: vi.fn(),
  renderPdfPage: vi.fn(),
}));

const progress = () => {};
let tmp: string;
let jpeg: Buffer;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "konte-comic-test-"));
  const out = path.join(tmp, "page.jpg");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=40x60",
    "-frames:v",
    "1",
    out,
  ]);
  jpeg = readFileSync(out);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// --- A minimal PDF writer: objects 1..n, a cross-reference table or stream.

type Obj = { dict: string; stream?: Buffer };

function grayFlate(width: number, height: number): Obj {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width + 1);
    row[0] = 2; // PNG "up": every row after the first repeats the one above
    for (let x = 0; x < width; x++) row[x + 1] = y === 0 ? x * 4 : 0;
    rows.push(row);
  }
  const data = deflateSync(Buffer.concat(rows));
  return {
    dict:
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray ` +
      `/BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns ${width} >> ` +
      `/Length ${data.length} >>`,
    stream: data,
  };
}

function monoFlate(width: number, height: number): Obj {
  const rowBytes = Math.ceil(width / 8);
  const data = deflateSync(Buffer.alloc(rowBytes * height, 0b10101010));
  return {
    dict:
      `<< /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray ` +
      `/BitsPerComponent 1 /Filter /FlateDecode /Length ${data.length} >>`,
    stream: data,
  };
}

function jpegImage(): Obj {
  return {
    dict:
      `<< /Type /XObject /Subtype /Image /Width 40 /Height 60 /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    stream: jpeg,
  };
}

// Pages, each drawing the images it names: `[[3], [4], [3, 4]]` with images numbered from 3 on.
function buildPdf(
  images: Obj[],
  pages: number[][],
  opts: { xrefStream?: boolean; direction?: "R2L" | "L2R"; contents?: string } = {},
): Buffer {
  const pageStart = 3 + images.length;
  const contentsRef = opts.contents ? ` /Contents ${pageStart + pages.length} 0 R` : "";
  const objs: Obj[] = [
    {
      dict: `<< /Type /Catalog /Pages 2 0 R${opts.direction ? ` /ViewerPreferences << /Direction /${opts.direction} >>` : ""} >>`,
    },
    {
      dict: `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageStart + i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    },
    ...images,
    ...pages.map((imgs) => ({
      dict:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 60] /Resources << /XObject << ` +
        `${imgs.map((n, k) => `/Im${k} ${n} 0 R`).join(" ")} >> >>${contentsRef} >>`,
    })),
    ...(opts.contents
      ? [
          {
            dict: `<< /Length ${opts.contents.length} >>`,
            stream: Buffer.from(opts.contents, "latin1"),
          },
        ]
      : []),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\n", "latin1")];
  let size = parts[0]!.length;
  const push = (b: Buffer) => {
    parts.push(b);
    size += b.length;
  };
  const offsets: number[] = [];
  const write = (n: number, o: Obj) => {
    offsets[n] = size;
    push(Buffer.from(`${n} 0 obj\n${o.dict}`, "latin1"));
    if (o.stream) {
      push(Buffer.from("\nstream\n", "latin1"));
      push(o.stream);
      push(Buffer.from("\nendstream", "latin1"));
    }
    push(Buffer.from("\nendobj\n", "latin1"));
  };
  if (!opts.xrefStream) {
    objs.forEach((o, i) => write(i + 1, o));
    const xref = size;
    const lines = [`xref\n0 ${objs.length + 1}\n`, "0000000000 65535 f \n"];
    for (let n = 1; n <= objs.length; n++)
      lines.push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    push(Buffer.from(lines.join(""), "latin1"));
    push(
      Buffer.from(
        `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
        "latin1",
      ),
    );
    return Buffer.concat(parts);
  }
  // Every dictionary but the image streams in one object stream, the cross-reference a stream.
  const packed = objs.map((o, i) => ({ n: i + 1, o })).filter(({ o }) => !o.stream);
  const streamNum = objs.length + 1;
  const xrefNum = objs.length + 2;
  let body = "";
  const header: string[] = [];
  for (const { n, o } of packed) {
    header.push(`${n} ${body.length}`);
    body += `${o.dict} `;
  }
  const head = `${header.join(" ")} `;
  const osData = deflateSync(Buffer.from(head + body, "latin1"));
  objs.forEach((o, i) => o.stream && write(i + 1, o));
  write(streamNum, {
    dict: `<< /Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode /Length ${osData.length} >>`,
    stream: osData,
  });
  const rows: Buffer[] = [];
  const row = (type: number, a: number, b: number) => {
    const r = Buffer.alloc(7);
    r[0] = type;
    r.writeUInt32BE(a, 1);
    r.writeUInt16BE(b, 5);
    rows.push(r);
  };
  row(0, 0, 65535);
  for (let n = 1; n <= objs.length; n++) {
    const k = packed.findIndex((p) => p.n === n);
    if (k === -1) row(1, offsets[n]!, 0);
    else row(2, streamNum, k);
  }
  row(1, offsets[streamNum]!, 0);
  const xrefOffset = size;
  row(1, xrefOffset, 0);
  const xrefData = deflateSync(Buffer.concat(rows));
  write(xrefNum, {
    dict:
      `<< /Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode ` +
      `/Length ${xrefData.length} >>`,
    stream: xrefData,
  });
  push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

// --- A minimal stored zip writer.

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function buildZip(files: Record<string, Buffer | string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function source(id: string, file: string, content?: Buffer): SourceRef {
  const dir = path.join(tmp, "videos", id, "source");
  mkdirSync(dir, { recursive: true });
  if (content) writeFileSync(path.join(dir, file), content);
  return { dir, file };
}

describe("Pdf", () => {
  it("reads the pages, the direction and each page's image off a cross-reference table", () => {
    const pdf = new Pdf(buildPdf([jpegImage(), grayFlate(8, 3)], [[3], [4]], { direction: "R2L" }));
    const pages = pdf.pages();
    expect(pages).toHaveLength(2);
    expect(pdf.direction()).toBe("rtl");
    const first = pdf.pageImage(pages[0]!);
    expect(first).toEqual({ bytes: jpeg, ext: ".jpg" });
    const second = pdf.pageImage(pages[1]!);
    expect(second).toMatchObject({ width: 8, height: 3, pixFmt: "gray" });
    if (!("raw" in second)) throw new Error("expected pixels");
    expect([...second.raw.subarray(0, 8)]).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect([...second.raw.subarray(16, 24)]).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });

  it("reads an object stream through a cross-reference stream", () => {
    const pdf = new Pdf(buildPdf([jpegImage()], [[3], [3], [3]], { xrefStream: true }));
    expect(pdf.pages()).toHaveLength(3);
    expect(pdf.direction()).toBeNull();
    expect(pdf.pageImage(pdf.pages()[2]!)).toEqual({ bytes: jpeg, ext: ".jpg" });
  });

  it("spreads a one-bit image to 8-bit gray", () => {
    const pdf = new Pdf(buildPdf([monoFlate(8, 2)], [[3]]));
    const img = pdf.pageImage(pdf.pages()[0]!);
    if (!("raw" in img)) throw new Error("expected pixels");
    expect([...img.raw.subarray(0, 4)]).toEqual([255, 0, 255, 0]);
  });

  it("tells a page that is one image from one that is not", () => {
    const pdf = new Pdf(buildPdf([jpegImage(), grayFlate(4, 4)], [[3], [3, 4], []]));
    expect(pdf.pages().map((p) => pdf.imageOnly(p))).toEqual([true, false, false]);
  });
});

describe("contentOperators", () => {
  it("reads the operators past operands, names and strings, and refuses an inline image", () => {
    expect(contentOperators(Buffer.from("q 40 0 0 60 0 0 cm /Im0 Do Q"))).toEqual([
      "q",
      "cm",
      "Do",
      "Q",
    ]);
    expect(contentOperators(Buffer.from("BT /F1 12 Tf (a (b) Tj) Tj ET"))).toEqual([
      "BT",
      "Tf",
      "Tj",
      "ET",
    ]);
    expect(contentOperators(Buffer.from("q BI /W 1 /H 1 ID x EI Q"))).toBeNull();
  });

  it("tells a page whose contents draw text over its image", () => {
    const placed = new Pdf(
      buildPdf([jpegImage()], [[3]], { contents: "q 40 0 0 60 0 0 cm /Im0 Do Q" }),
    );
    expect(placed.imageOnly(placed.pages()[0]!)).toBe(true);
    const captioned = new Pdf(
      buildPdf([jpegImage()], [[3]], {
        contents: "q 40 0 0 60 0 0 cm /Im0 Do Q BT /F1 12 Tf (caption) Tj ET",
      }),
    );
    expect(captioned.imageOnly(captioned.pages()[0]!)).toBe(false);
  });
});

describe("comicInfoBinding", () => {
  it("reads right to left off YesAndRightToLeft only", () => {
    expect(comicInfoBinding("<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>")).toBe("rtl");
    expect(comicInfoBinding("<ComicInfo><Manga>No</Manga></ComicInfo>")).toBe("ltr");
    expect(comicInfoBinding("<ComicInfo><Manga>Unknown</Manga></ComicInfo>")).toBeNull();
    expect(comicInfoBinding("<ComicInfo></ComicInfo>")).toBeNull();
  });
});

describe("sheetOrder", () => {
  const pages = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ page: from + i, cell: from + i }));

  it("sets a lone first page beside a blank, and reads each row from the right when rtl", () => {
    expect(sheetOrder(pages(1, 5), 4, "ltr", 0)).toEqual([0, 1, 2, 3, 4, 5, 0, 0]);
    expect(sheetOrder(pages(1, 5), 4, "rtl", 0)).toEqual([3, 2, 1, 0, 0, 0, 5, 4]);
  });
});

describe("imageHeaderSize", () => {
  it("reads a JPEG's size off its frame header", () => {
    expect(imageHeaderSize(jpeg)).toEqual({ width: 40, height: 60 });
  });
});

describe("study comic", () => {
  it("bundles a PDF's pages by twelve and writes each bundle's pages, sheet and list", async () => {
    const pdf = buildPdf([jpegImage(), grayFlate(40, 60)], [...Array(13).fill([3]), [4]], {
      direction: "R2L",
    });
    const src = source("pdf", "book.pdf", pdf);
    const { index } = await studySource(src, { progress });
    expect(index.kind).toBe("comic");
    expect(index.binding).toBe("rtl");
    expect(index.summary).toBe("14 pages · 2 bundles · rtl");
    expect(index.notes).toEqual([
      "binding rtl read off the PDF — --binding ltr where its pages turn the other way",
    ]);
    expect(index.chunks.map((c) => [c.id, c.from, c.to])).toEqual([
      ["v1.b1", 1, 12],
      ["v1.b2", 13, 14],
    ]);
    expect(index.units.map((u) => u.id)).toEqual(["v1.b1", "v1.b2"]);
    const study = path.join(src.dir, "chunks");
    for (const f of ["v1.b1.md", "v1.b1.jpg", "v1.b1/p001.jpg", "v1.b2/p014.jpg", "index.md"]) {
      expect(existsSync(path.join(study, f.replace("v1.b", "v01.b0")))).toBe(true);
    }
    expect(readFileSync(path.join(study, "v01.b01.md"), "utf-8")).toContain(
      "v1.p12 v01.b01/p012.jpg",
    );
    const excerpt = await sourceExcerpt(src, index, "v1.b2", { prefix: "v1", from: 13, to: 14 });
    expect(excerpt).toEqual({
      images: [path.join(study, "v01.b02/p013.jpg"), path.join(study, "v01.b02/p014.jpg")],
    });

    const flipped = await studySource(src, { progress, binding: "ltr" });
    expect(flipped.recounted).toBe(true);
    expect(flipped.index.binding).toBe("ltr");
    expect(readFileSync(path.join(study, "v01.b01.md"), "utf-8")).toContain("(ltr)");
    expect((await studySource(src, { progress })).index.binding).toBe("ltr");

    const page = await comicPage(src, "v1.p14", { progress });
    expect(page).toMatchObject({ width: 40, height: 60 });
    expect(path.extname(page.path)).toBe(".png");
    await expect(comicPage(src, "v1.p15", { progress })).rejects.toThrow(/outside/);
  }, 60_000);

  it("draws a page that is not one image, and every page of a PDF it cannot open", async () => {
    vi.mocked(renderPdfPage).mockClear().mockResolvedValue(jpeg);
    const captioned = buildPdf([jpegImage()], [[3], [3]], {
      direction: "R2L",
      contents: "q 40 0 0 60 0 0 cm /Im0 Do Q BT /F1 12 Tf (caption) Tj ET",
    });
    const src = source("drawn", "book.pdf", captioned);
    await studySource(src, { progress });
    expect(vi.mocked(renderPdfPage).mock.calls.map(([, n]) => n)).toEqual([1, 2]);
    expect(existsSync(path.join(src.dir, "chunks", "v01.b01", "p002.jpg"))).toBe(true);

    vi.mocked(renderPdfPage).mockClear();
    vi.mocked(pdfInfo).mockResolvedValue({ pages: 3, direction: "ltr" });
    const sealed = source("sealed", "sealed.pdf", Buffer.from("%PDF-1.7\nnot readable here\n"));
    const { index } = await studySource(sealed, { progress });
    expect(index.summary).toBe("3 pages · 1 bundle · ltr");
    expect(vi.mocked(renderPdfPage).mock.calls.map(([, n]) => n)).toEqual([1, 2, 3]);
  }, 60_000);

  it("reads a cbz's binding off ComicInfo.xml and its pages in natural order", async () => {
    const cbz = buildZip({
      "ComicInfo.xml": "<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>",
      "p10.jpg": jpeg,
      "p2.jpg": jpeg,
      "p1.jpg": jpeg,
      "__MACOSX/._p1.jpg": "junk",
    });
    const src = source("cbz", "book.cbz", cbz);
    const { index } = await studySource(src, { progress });
    expect(index.binding).toBe("rtl");
    expect(index.chunks).toHaveLength(1);
    expect(index.chunks[0]).toMatchObject({ id: "v1.b1", from: 1, to: 3 });
    const page = await comicPage(src, "v1.p3", { progress });
    expect(path.basename(page.path)).toBe("v1.p003.jpg");
  }, 60_000);

  it("reads each PDF a zip wraps as a volume", async () => {
    const zip = buildZip({
      "vol10.pdf": buildPdf([jpegImage()], [[3]], { direction: "R2L" }),
      "vol2.pdf": buildPdf([jpegImage()], [[3], [3]], { direction: "R2L" }),
    });
    const src = source("vols", "set.zip", zip);
    const { index } = await studySource(src, { progress });
    expect(index.units).toEqual([
      { id: "v1", title: "vol2.pdf" },
      { id: "v2", title: "vol10.pdf" },
    ]);
    expect(index.chunks.map((c) => [c.id, c.unit, c.to])).toEqual([
      ["v1.b1", "v1", 2],
      ["v2.b1", "v2", 1],
    ]);
    expect(index.summary).toBe("3 pages · 2 volumes · 2 bundles · rtl");
  }, 60_000);

  it("refuses a directory whose binding nothing states, and takes --binding", async () => {
    const src = source("dir", "pages");
    mkdirSync(path.join(src.dir, "pages"), { recursive: true });
    writeFileSync(path.join(src.dir, "pages", "001.jpg"), jpeg);
    writeFileSync(path.join(src.dir, "pages", "002.jpg"), jpeg);
    const refused = await studySource(src, { progress }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(KonteError);
    expect((refused as KonteError).code).toBe("COMIC_BINDING_UNKNOWN");
    expect((refused as KonteError).headline).toContain("--binding rtl");
    const { index } = await studySource(src, { progress, binding: "ltr" });
    expect(index.binding).toBe("ltr");
    expect(index.notes).toEqual(["binding ltr given by --binding"]);
  }, 60_000);

  it("counts a page added to a subfolder of a directory again", async () => {
    const src = source("nested", "pages");
    mkdirSync(path.join(src.dir, "pages", "a"), { recursive: true });
    writeFileSync(path.join(src.dir, "pages", "a", "001.jpg"), jpeg);
    const first = await refreshStudyIndex(src, { progress, binding: "ltr" });
    expect(first.index.chunks[0]!.to).toBe(1);
    writeFileSync(path.join(src.dir, "pages", "a", "002.jpg"), jpeg);
    const second = await refreshStudyIndex(src, { progress });
    expect(second.recounted).toBe(true);
    expect(second.index.chunks[0]!.to).toBe(2);
  }, 60_000);
});
