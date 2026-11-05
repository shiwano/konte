import * as fs from "node:fs";
import * as path from "node:path";
import initLindera, {
  loadDictionaryFromBytes,
  type Tokenizer,
  TokenizerBuilder,
} from "lindera-wasm";
// The package exports no path to its WASM build.
import linderaWasm from "../../node_modules/lindera-wasm/lindera_wasm_bg.wasm" with { type: "file" };
import yauzl from "yauzl";
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { provisionOnce, toolCacheDir } from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";

// IPADIC built for lindera, read by `lindera-wasm` of the same version.
const IPADIC_VERSION = "6.2.0";
export const IPADIC_URL = `https://github.com/lindera/lindera/releases/download/v${IPADIC_VERSION}/lindera-ipadic-${IPADIC_VERSION}.zip`;
const IPADIC_FILES = [
  "metadata.json",
  "dict.trie",
  "dict.valsidx",
  "dict.vals",
  "dict.wordsidx",
  "dict.words",
  "matrix.mtx",
  "char_def.bin",
  "unk.bin",
] as const;
// IPADIC's pronunciation field: `は` as a particle reads `ワ`.
const PRONUNCIATION = 8;

/** One token of a Japanese text: the [at, end) it covers and how it is pronounced, in katakana. */
type ReadToken = { at: number; end: number; pronunciation: string };

/** The tokens of a text, in order. */
export type JapaneseReader = (text: string) => ReadToken[];

async function unzipInto(archive: string, dest: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true }, (err, z) => (err ? reject(err) : resolve(z!))),
  );
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = path.posix.basename(entry.fileName);
      if (entry.fileName.endsWith("/") || !(IPADIC_FILES as readonly string[]).includes(name)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const out = fs.createWriteStream(path.join(dest, name));
        stream.on("error", reject);
        out.on("error", reject);
        out.on("finish", () => zip.readEntry());
        stream.pipe(out);
      });
    });
    zip.readEntry();
  });
  zip.close();
}

// The directory holding IPADIC, downloading it on first use; `KONTE_IPADIC_DIR` names one instead.
async function ipadicDir(): Promise<string> {
  const override = process.env.KONTE_IPADIC_DIR;
  if (override) return override;
  const dir = toolCacheDir(`lindera-ipadic-${IPADIC_VERSION}`);
  await provisionOnce({
    dir,
    pin: toolPin([IPADIC_URL]),
    files: IPADIC_FILES,
    label: `IPADIC ${IPADIC_VERSION}`,
    errorCode: "IPADIC_SETUP_FAILED",
    fill: async () => {
      const tmp = fs.mkdtempSync(path.join(dir, ".dl-"));
      try {
        const archive = path.join(tmp, "ipadic.zip");
        await downloadFile(IPADIC_URL, archive, progressReporter("ipadic"));
        endProgress();
        await unzipInto(archive, dir);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  });
  return dir;
}

// Each UTF-16 index of `text` at each UTF-8 byte offset a token can start or end at.
function utf16AtByte(text: string): Map<number, number> {
  const at = new Map<number, number>();
  let byte = 0;
  let i = 0;
  for (const ch of text) {
    at.set(byte, i);
    byte += Buffer.byteLength(ch);
    i += ch.length;
  }
  at.set(byte, i);
  return at;
}

function readerOf(tokenizer: Tokenizer): JapaneseReader {
  return (text) => {
    if (text === "") return [];
    const at = utf16AtByte(text);
    return tokenizer.tokenize(text).map((t) => {
      const start = at.get(t.byteStart)!;
      const end = at.get(t.byteEnd)!;
      const said = t.details[PRONUNCIATION];
      return {
        at: start,
        end,
        pronunciation: said && said !== "*" ? said : text.slice(start, end),
      };
    });
  };
}

let reader: Promise<JapaneseReader> | null = null;

/** IPADIC's reading of Japanese, loaded once per process. */
export function japaneseReader(): Promise<JapaneseReader> {
  reader ??= (async () => {
    const dir = await ipadicDir();
    await initLindera({ module_or_path: fs.readFileSync(linderaWasm) });
    const bytes = IPADIC_FILES.map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))));
    const dictionary = loadDictionaryFromBytes(
      ...(bytes as [
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Uint8Array,
      ]),
    );
    const builder = new TokenizerBuilder();
    builder.setDictionaryInstance(dictionary);
    builder.setMode("normal");
    return readerOf(builder.build());
  })().catch((err) => {
    reader = null;
    throw err;
  });
  return reader;
}
