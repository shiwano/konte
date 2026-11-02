// A minimal PDF reader: the object graph (cross-reference tables, cross-reference streams and object
// streams), the page tree, and each page's image XObject.

import { inflateSync, constants as zlibConstants } from "node:zlib";

export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfParseError";
  }
}

// A page's one image as it is stored: its JPEG bytes, or the pixels of a Flate image.
export type PdfPageImage =
  | { bytes: Buffer; ext: ".jpg" }
  | { raw: Buffer; width: number; height: number; pixFmt: "gray" | "rgb24" };

export class PdfName {
  constructor(readonly name: string) {}
}
export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
export class PdfString {
  constructor(readonly bytes: Buffer) {}
}
export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    readonly data: Buffer,
  ) {}
}
export type PdfDict = Map<string, PdfValue>;
export type PdfValue =
  | number
  | boolean
  | null
  | PdfName
  | PdfRef
  | PdfString
  | PdfStream
  | PdfDict
  | PdfValue[];

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...WS, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class PdfLexer {
  constructor(
    readonly buf: Buffer,
    public pos: number,
    // Resolves an indirect `/Length`; absent while the cross-reference itself is being read.
    readonly resolveLength?: (ref: PdfRef) => PdfValue,
  ) {}

  skipWs(): void {
    const { buf } = this;
    while (this.pos < buf.length) {
      const c = buf[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < buf.length && buf[this.pos] !== 10 && buf[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  word(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && !DELIM.has(this.buf[this.pos]!)) this.pos++;
    return this.buf.toString("latin1", start, this.pos);
  }

  peekWord(): string {
    const at = this.pos;
    this.skipWs();
    const w = this.word();
    this.pos = at;
    return w;
  }

  value(): PdfValue {
    this.skipWs();
    const { buf } = this;
    const c = buf[this.pos];
    if (c === undefined) throw new PdfParseError("unexpected end of PDF");
    if (c === 0x3c && buf[this.pos + 1] === 0x3c) return this.dictOrStream();
    if (c === 0x3c) return this.hexString();
    if (c === 0x28) return this.literalString();
    if (c === 0x5b) return this.array();
    if (c === 0x2f) {
      this.pos++;
      return new PdfName(
        this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      );
    }
    const w = this.word();
    if (w === "") throw new PdfParseError(`unexpected byte ${c} at ${this.pos}`);
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    const n = Number(w);
    if (Number.isNaN(n)) throw new PdfParseError(`unexpected token ${w} at ${this.pos}`);
    if (/^\d+$/.test(w)) {
      const at = this.pos;
      this.skipWs();
      const gen = this.word();
      if (/^\d+$/.test(gen)) {
        this.skipWs();
        if (this.word() === "R") return new PdfRef(n, Number(gen));
      }
      this.pos = at;
    }
    return n;
  }

  private array(): PdfValue[] {
    this.pos++;
    const arr: PdfValue[] = [];
    this.skipWs();
    while (this.buf[this.pos] !== 0x5d) {
      arr.push(this.value());
      this.skipWs();
    }
    this.pos++;
    return arr;
  }

  private dictOrStream(): PdfDict | PdfStream {
    this.pos += 2;
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipWs();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.value();
      if (!(key instanceof PdfName))
        throw new PdfParseError(`dictionary key is not a name at ${this.pos}`);
      dict.set(key.name, this.value());
    }
    const at = this.pos;
    this.skipWs();
    if (this.word() !== "stream") {
      this.pos = at;
      return dict;
    }
    if (this.buf[this.pos] === 13) this.pos++;
    if (this.buf[this.pos] === 10) this.pos++;
    const start = this.pos;
    let length = dict.get("Length");
    if (length instanceof PdfRef) length = this.resolveLength?.(length) ?? null;
    let end = typeof length === "number" && start + length <= this.buf.length ? start + length : -1;
    if (end === -1 || !this.buf.toString("latin1", end, end + 20).includes("endstream")) {
      end = this.buf.indexOf("endstream", start, "latin1");
      if (end === -1) throw new PdfParseError("stream without endstream");
      while (end > start && (this.buf[end - 1] === 10 || this.buf[end - 1] === 13)) end--;
    }
    this.pos = end;
    const after = this.buf.indexOf("endstream", end, "latin1");
    if (after !== -1) this.pos = after + "endstream".length;
    return new PdfStream(dict, this.buf.subarray(start, end));
  }

  private hexString(): PdfString {
    this.pos++;
    const end = this.buf.indexOf(0x3e, this.pos);
    const hex = this.buf.toString("latin1", this.pos, end).replace(/\s+/g, "");
    this.pos = end + 1;
    return new PdfString(Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex"));
  }

  private literalString(): PdfString {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    const { buf } = this;
    while (this.pos < buf.length) {
      const c = buf[this.pos++]!;
      if (c === 0x5c) {
        const e = buf[this.pos++]!;
        const esc: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (esc[e] !== undefined) out.push(esc[e]!);
        else if (e >= 0x30 && e <= 0x37) {
          let oct = e - 0x30;
          for (let k = 0; k < 2 && buf[this.pos]! >= 0x30 && buf[this.pos]! <= 0x37; k++) {
            oct = oct * 8 + buf[this.pos++]! - 0x30;
          }
          out.push(oct & 0xff);
        } else if (e === 13) {
          if (buf[this.pos] === 10) this.pos++;
        } else if (e !== 10) out.push(e);
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return new PdfString(Buffer.from(out));
  }
}

type XrefEntry = { offset: number } | { stream: number; index: number };

// The content operators a page that only places its image uses: graphics state, the matrix, `Do`,
// a clip that paints nothing, and marked-content and compatibility brackets.
const IMAGE_ONLY_OPERATORS = new Set([
  ...["q", "Q", "cm", "gs", "w", "J", "j", "M", "d", "ri", "i", "Do"],
  ...["re", "W", "W*", "n"],
  ...["BMC", "BDC", "EMC", "MP", "DP", "BX", "EX"],
]);

/** Every operator of a content stream in order, or null where it holds an inline image. */
export function contentOperators(data: Buffer): string[] | null {
  const ops: string[] = [];
  const delim = (c: number) => "()<>[]{}/%".includes(String.fromCharCode(c));
  const space = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  let i = 0;
  while (i < data.length) {
    const c = data[i]!;
    if (space(c)) i++;
    else if (c === 0x25) while (i < data.length && data[i] !== 10 && data[i] !== 13) i++;
    else if (c === 0x28) {
      let depth = 0;
      for (; i < data.length; i++) {
        if (data[i] === 0x5c) i++;
        else if (data[i] === 0x28) depth++;
        else if (data[i] === 0x29 && --depth === 0) {
          i++;
          break;
        }
      }
    } else if (c === 0x3c && data[i + 1] !== 0x3c) {
      while (i < data.length && data[i] !== 0x3e) i++;
      i++;
    } else if (delim(c)) {
      i++;
      if (c === 0x2f) while (i < data.length && !space(data[i]!) && !delim(data[i]!)) i++;
    } else {
      const start = i;
      while (i < data.length && !space(data[i]!) && !delim(data[i]!)) i++;
      const token = data.subarray(start, i).toString("latin1");
      if (
        /^[+-]?(\d+\.?\d*|\.\d+)$/.test(token) ||
        token === "true" ||
        token === "false" ||
        token === "null"
      )
        continue;
      if (token === "BI") return null;
      ops.push(token);
    }
  }
  return ops;
}

function num(v: PdfValue | undefined): number {
  return typeof v === "number" ? v : 0;
}

function name(v: PdfValue | undefined): string | null {
  return v instanceof PdfName ? v.name : null;
}

/** Undoes a PNG (10–15) or TIFF (2, 8-bit) predictor. */
export function unpredict(data: Buffer, params: PdfDict | null): Buffer {
  const predictor = num(params?.get("Predictor")) || 1;
  if (predictor === 1) return data;
  const colors = num(params?.get("Colors")) || 1;
  const bpc = num(params?.get("BitsPerComponent")) || 8;
  const columns = num(params?.get("Columns")) || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) throw new PdfParseError("TIFF predictor below 8 bits per component");
    const out = Buffer.from(data);
    for (let r = 0; r < out.length; r += rowLen) {
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i]! + out[r + i - bpp]!) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]!;
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = r > 0 ? out[dst - rowLen + i]! : 0;
      const c = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp]! : 0;
      let v: number;
      switch (type) {
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function inflate(data: Buffer): Buffer {
  try {
    return inflateSync(data);
  } catch {
    // A stream cut short of its checksum still inflates up to where it ends.
    return inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
  }
}

export class Pdf {
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfValue>();
  private readonly objectStreams = new Map<number, { offsets: number[]; lexer: PdfLexer }>();
  private trailer: PdfDict = new Map();

  constructor(private readonly buf: Buffer) {
    if (buf.toString("latin1", 0, 1024).indexOf("%PDF-") === -1)
      throw new PdfParseError("not a PDF");
    try {
      this.readXref();
      if (!this.trailer.has("Root")) throw new PdfParseError("no Root");
    } catch {
      this.xref.clear();
      this.scanObjects();
    }
  }

  private readXref(): void {
    const at = this.buf.lastIndexOf("startxref", undefined, "latin1");
    if (at === -1) throw new PdfParseError("no startxref");
    const lx = new PdfLexer(this.buf, at + "startxref".length);
    lx.skipWs();
    let offset: number | null = Number(lx.word());
    const seen = new Set<number>();
    while (offset !== null && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefSection(offset);
      for (const [k, v] of trailer) if (!this.trailer.has(k)) this.trailer.set(k, v);
      const hybrid = trailer.get("XRefStm");
      if (typeof hybrid === "number" && !seen.has(hybrid)) {
        seen.add(hybrid);
        this.readXrefSection(hybrid);
      }
      const prev = trailer.get("Prev");
      offset = typeof prev === "number" ? prev : null;
    }
  }

  private setEntry(n: number, entry: XrefEntry): void {
    if (!this.xref.has(n)) this.xref.set(n, entry);
  }

  private readXrefSection(offset: number): PdfDict {
    const lx = new PdfLexer(this.buf, offset);
    lx.skipWs();
    if (lx.peekWord() === "xref") {
      lx.skipWs();
      lx.word();
      for (;;) {
        lx.skipWs();
        const first = lx.word();
        if (first === "trailer") break;
        lx.skipWs();
        const count = Number(lx.word());
        let n = Number(first);
        if (Number.isNaN(n) || Number.isNaN(count)) throw new PdfParseError("bad xref table");
        for (let i = 0; i < count; i++, n++) {
          lx.skipWs();
          const off = Number(lx.word());
          lx.skipWs();
          lx.word();
          lx.skipWs();
          const type = lx.word();
          if (type === "n") this.setEntry(n, { offset: off });
          else this.setEntry(n, { offset: -1 });
        }
      }
      const trailer = lx.value();
      if (!(trailer instanceof Map)) throw new PdfParseError("bad trailer");
      return trailer;
    }
    const obj = this.objectAt(offset);
    if (!(obj instanceof PdfStream) || name(obj.dict.get("Type")) !== "XRef")
      throw new PdfParseError("bad xref stream");
    const w = (obj.dict.get("W") as PdfValue[]).map(num);
    const size = num(obj.dict.get("Size"));
    const idx = ((obj.dict.get("Index") as PdfValue[] | undefined) ?? [0, size]).map(num);
    const data = this.decodeStream(obj);
    const rowLen = w[0]! + w[1]! + w[2]!;
    let p = 0;
    const field = (len: number, dflt: number) => {
      if (len === 0) return dflt;
      let v = 0;
      for (let k = 0; k < len; k++) v = v * 256 + data[p++]!;
      return v;
    };
    for (let s = 0; s < idx.length; s += 2) {
      for (let i = 0; i < idx[s + 1]! && p + rowLen <= data.length; i++) {
        const n = idx[s]! + i;
        const type = field(w[0]!, 1);
        const a = field(w[1]!, 0);
        const b = field(w[2]!, 0);
        if (type === 1) this.setEntry(n, { offset: a });
        else if (type === 2) this.setEntry(n, { stream: a, index: b });
        else this.setEntry(n, { offset: -1 });
      }
    }
    return obj.dict;
  }

  // A file whose cross-reference does not read: every `N G obj` in it, the last of a number winning.
  private scanObjects(): void {
    const text = this.buf.toString("latin1");
    const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      this.xref.set(Number(m[1]), { offset: m.index + m[0].indexOf(m[1]!) });
    }
    this.cache.clear();
    for (const t of [...text.matchAll(/trailer\s*<</g)].reverse()) {
      const v = new PdfLexer(this.buf, t.index! + "trailer".length).value();
      if (v instanceof Map && v.has("Root")) {
        this.trailer = v;
        return;
      }
    }
    for (const [n] of this.xref) {
      const v = this.get(new PdfRef(n, 0));
      const dict = v instanceof PdfStream ? v.dict : v;
      if (dict instanceof Map && name(dict.get("Type")) === "XRef" && dict.has("Root")) {
        this.trailer = dict;
        return;
      }
      if (dict instanceof Map && name(dict.get("Type")) === "Catalog") {
        this.trailer = new Map([["Root", new PdfRef(n, 0)]]);
        return;
      }
    }
    throw new PdfParseError("no document catalog");
  }

  private lexer(pos: number): PdfLexer {
    return new PdfLexer(this.buf, pos, (ref) => this.get(ref));
  }

  private objectAt(offset: number): PdfValue {
    const lx = this.lexer(offset);
    lx.skipWs();
    lx.word();
    lx.skipWs();
    lx.word();
    lx.skipWs();
    if (lx.word() !== "obj") throw new PdfParseError(`no object at ${offset}`);
    return lx.value();
  }

  get(v: PdfValue | undefined): PdfValue {
    if (!(v instanceof PdfRef)) return v ?? null;
    if (this.cache.has(v.num)) return this.cache.get(v.num)!;
    this.cache.set(v.num, null);
    const entry = this.xref.get(v.num);
    let value: PdfValue = null;
    try {
      if (entry && "offset" in entry && entry.offset >= 0) value = this.objectAt(entry.offset);
      else if (entry && "stream" in entry) value = this.inObjectStream(entry.stream, entry.index);
    } catch {
      value = null;
    }
    this.cache.set(v.num, value);
    return value;
  }

  private inObjectStream(streamNum: number, index: number): PdfValue {
    let os = this.objectStreams.get(streamNum);
    if (!os) {
      const stream = this.get(new PdfRef(streamNum, 0));
      if (!(stream instanceof PdfStream)) return null;
      const data = this.decodeStream(stream);
      const n = num(stream.dict.get("N"));
      const first = num(stream.dict.get("First"));
      const head = new PdfLexer(data, 0);
      const offsets: number[] = [];
      for (let i = 0; i < n; i++) {
        head.value();
        offsets.push(first + num(head.value()));
      }
      os = { offsets, lexer: new PdfLexer(data, 0, (ref) => this.get(ref)) };
      this.objectStreams.set(streamNum, os);
    }
    const at = os.offsets[index];
    if (at === undefined) return null;
    os.lexer.pos = at;
    return os.lexer.value();
  }

  private filters(stream: PdfStream): { names: string[]; params: (PdfDict | null)[] } {
    const f = this.get(stream.dict.get("Filter"));
    const names = (Array.isArray(f) ? f : f ? [f] : []).map((x) => name(this.get(x)) ?? "");
    const p = this.get(stream.dict.get("DecodeParms"));
    const params = (Array.isArray(p) ? p : [p]).map((x) => {
      const d = this.get(x);
      return d instanceof Map ? d : null;
    });
    return { names, params };
  }

  /** A stream's bytes through every filter but a final image codec, which `stopAt` keeps encoded. */
  decodeStream(stream: PdfStream, stopAt: readonly string[] = []): Buffer {
    const { names, params } = this.filters(stream);
    let data = stream.data;
    for (const [i, f] of names.entries()) {
      if (stopAt.includes(f)) break;
      if (f === "FlateDecode" || f === "Fl") data = unpredict(inflate(data), params[i] ?? null);
      else throw new PdfParseError(`a stream filtered by ${f}`);
    }
    return data;
  }

  private dict(v: PdfValue | undefined): PdfDict | null {
    const d = this.get(v);
    return d instanceof Map ? d : d instanceof PdfStream ? d.dict : null;
  }

  /** The `/Direction` the catalog's viewer preferences state. */
  direction(): "rtl" | "ltr" | null {
    const prefs = this.dict(this.dict(this.trailer.get("Root"))?.get("ViewerPreferences"));
    const d = name(this.get(prefs?.get("Direction")));
    return d === "R2L" ? "rtl" : d === "L2R" ? "ltr" : null;
  }

  get bytes(): Buffer {
    return this.buf;
  }

  get encrypted(): boolean {
    return this.trailer.has("Encrypt");
  }

  /** Every page in order, with the resources it inherits. */
  pages(): PdfDict[] {
    const root = this.dict(this.trailer.get("Root"));
    const pages: PdfDict[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | null, resources: PdfValue | undefined) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const res = node.get("Resources") ?? resources;
      const kids = this.get(node.get("Kids"));
      if (name(node.get("Type")) === "Pages" || Array.isArray(kids)) {
        for (const kid of Array.isArray(kids) ? kids : []) walk(this.dict(kid), res);
        return;
      }
      pages.push(new Map([...node, ["Resources", res ?? null]]));
    };
    walk(this.dict(root?.get("Pages")), undefined);
    return pages;
  }

  /** Whether the page carries exactly one image and paints nothing else. */
  imageOnly(page: PdfDict): boolean {
    return this.imageOf(page) !== null && this.drawsOnlyImages(page);
  }

  // Whether the page's contents paint nothing but its XObject: text or a vector drawn over the image
  // would be lost when the image is taken alone.
  private drawsOnlyImages(page: PdfDict): boolean {
    const contents = this.get(page.get("Contents"));
    const streams = (Array.isArray(contents) ? contents : [contents]).map((c) => this.get(c));
    if (!streams.every((s) => s instanceof PdfStream || s === null)) return false;
    const ops = contentOperators(
      Buffer.concat(
        streams.flatMap((s) => (s ? [this.decodeStream(s as PdfStream), Buffer.from("\n")] : [])),
      ),
    );
    return ops !== null && ops.every((op) => IMAGE_ONLY_OPERATORS.has(op));
  }

  private imageOf(page: PdfDict): PdfStream | null {
    const xobjects = this.dict(this.dict(page.get("Resources"))?.get("XObject"));
    if (!xobjects) return null;
    const drawn = [...xobjects.values()].map((v) => this.get(v));
    if (drawn.length !== 1) return null;
    const image = drawn[0];
    if (!(image instanceof PdfStream) || name(image.dict.get("Subtype")) !== "Image") return null;
    if (this.get(image.dict.get("ImageMask")) === true) return null;
    return image;
  }

  /** The page's one image: its JPEG bytes as stored, or its decoded pixels. */
  pageImage(page: PdfDict): PdfPageImage {
    const image = this.imageOf(page)!;
    const { names } = this.filters(image);
    if (names.at(-1) === "DCTDecode" || names.at(-1) === "DCT") {
      return { bytes: this.decodeStream(image, ["DCTDecode", "DCT"]), ext: ".jpg" };
    }
    if (names.some((f) => f !== "FlateDecode" && f !== "Fl")) {
      throw new PdfParseError(
        `a PDF page image is encoded as ${names.join(", ")}, which konte does not decode`,
      );
    }
    return this.pixels(image, this.decodeStream(image));
  }

  private pixels(image: PdfStream, data: Buffer): PdfPageImage {
    const width = num(this.get(image.dict.get("Width")));
    const height = num(this.get(image.dict.get("Height")));
    const bpc = num(this.get(image.dict.get("BitsPerComponent"))) || 8;
    const decode = this.get(image.dict.get("Decode"));
    const inverted = Array.isArray(decode) && num(decode[0]) === 1 && num(decode[1]) === 0;
    let cs = this.get(image.dict.get("ColorSpace"));
    let palette: Buffer | null = null;
    let paletteBase = 3;
    const components = (space: PdfValue): number => {
      const n = name(space);
      if (n === "DeviceGray" || n === "G" || n === "CalGray") return 1;
      if (n === "DeviceCMYK" || n === "CMYK") return 4;
      if (n) return 3;
      if (Array.isArray(space)) {
        const kind = name(space[0]);
        if (kind === "ICCBased") {
          const s = this.get(space[1]);
          return s instanceof PdfStream ? num(this.get(s.dict.get("N"))) || 3 : 3;
        }
        if (kind === "CalGray") return 1;
        return 3;
      }
      return 1;
    };
    if (Array.isArray(cs) && (name(cs[0]) === "Indexed" || name(cs[0]) === "I")) {
      paletteBase = components(this.get(cs[1]));
      const lookup = this.get(cs[3]);
      palette =
        lookup instanceof PdfStream
          ? this.decodeStream(lookup)
          : lookup instanceof PdfString
            ? lookup.bytes
            : Buffer.alloc(0);
      cs = null;
    }
    const comps = palette ? 1 : components(cs);
    const rowBits = width * comps * bpc;
    const rowBytes = Math.ceil(rowBits / 8);
    const sample = (row: number, i: number): number => {
      const bit = i * bpc;
      const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
      if (bpc === 8) return byte;
      if (bpc === 16) return byte;
      const shift = 8 - bpc - (bit & 7);
      return (byte >> shift) & ((1 << bpc) - 1);
    };
    const scale = bpc >= 8 ? 1 : 255 / ((1 << bpc) - 1);
    const sampleAt = (row: number, i: number) =>
      bpc === 16 ? (data[row * rowBytes + i * 2] ?? 0) : sample(row, i);
    if (palette) {
      const out = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = sampleAt(y, x);
          const o = (y * width + x) * 3;
          const c = (k: number) => palette![idx * paletteBase + k] ?? 0;
          if (paletteBase === 1) out[o] = out[o + 1] = out[o + 2] = c(0);
          else if (paletteBase === 4) {
            out[o] = 255 - Math.min(255, c(0) + c(3));
            out[o + 1] = 255 - Math.min(255, c(1) + c(3));
            out[o + 2] = 255 - Math.min(255, c(2) + c(3));
          } else [out[o], out[o + 1], out[o + 2]] = [c(0), c(1), c(2)];
        }
      }
      return { raw: out, width, height, pixFmt: "rgb24" };
    }
    if (comps === 1) {
      const out = Buffer.alloc(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = Math.round(sampleAt(y, x) * scale);
          out[y * width + x] = inverted ? 255 - v : v;
        }
      }
      return { raw: out, width, height, pixFmt: "gray" };
    }
    const out = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 3;
        const s = (k: number) => Math.round(sampleAt(y, x * comps + k) * scale);
        if (comps === 4) {
          out[o] = 255 - Math.min(255, s(0) + s(3));
          out[o + 1] = 255 - Math.min(255, s(1) + s(3));
          out[o + 2] = 255 - Math.min(255, s(2) + s(3));
        } else [out[o], out[o + 1], out[o + 2]] = [s(0), s(1), s(2)];
      }
    }
    return { raw: out, width, height, pixFmt: "rgb24" };
  }
}
