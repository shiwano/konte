import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  GUIDE_SPECIFIER_PREFIX,
  adapterGuides,
  isAssetAdapter,
  type AdapterBackendKind,
  type AdapterMeta,
} from "./dsl/adapter.js";
import { adapters as prebuiltAdapters } from "./dsl/index.js";
// Importing the loader also registers the Bun module shim that resolves a workspace adapter's
// `import … from "konte"`.
import { importModule } from "./loader.js";

export interface AdapterCatalogEntry {
  name: string;
  // What a video file writes to reach the adapter: `konte` for a prebuilt one (used as
  // `adapters.<name>`), else the workspace-rooted `konte/workspace/adapters/<path>.js` specifier
  // (resolved by tsconfig `paths` + the loader shim, which requires the extension).
  importFrom: string;
  meta: AdapterMeta;
  // The adapter's `meta.guide`, in its order, each as an absolute on-disk path or null when it
  // names a file that is not there. `.konte/` exists at both the workspace root and a video root,
  // so a relative path would name a real but wrong directory from the other one.
  guides: AdapterGuide[];
}

export interface AdapterGuide {
  specifier: string;
  path: string | null;
}

interface AdapterCatalog {
  entries: AdapterCatalogEntry[];
  // A workspace adapter file that failed to import — reported per file so one broken
  // adapter doesn't take the whole listing down with it.
  errors: { file: string; message: string }[];
}

const ADAPTERS_DIR = "adapters";
const PREBUILT_IMPORT = "konte";

async function listAdapterFiles(dir: string): Promise<string[]> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await listAdapterFiles(full)));
    } else if (/\.tsx?$/.test(dirent.name) && !dirent.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

// `konte/guides/<name>.md` is the konte-managed doc the template syncs into every workspace;
// anything else is a path beside the adapter file. A prebuilt adapter has no file of its own and
// takes the managed form only.
export function resolveGuidePath(
  specifier: string,
  workspaceRoot: string,
  adapterFile: string | null,
): string | null {
  const resolved = specifier.startsWith(GUIDE_SPECIFIER_PREFIX)
    ? path.join(workspaceRoot, ".konte", "guides", specifier.slice(GUIDE_SPECIFIER_PREFIX.length))
    : adapterFile
      ? path.resolve(path.dirname(adapterFile), specifier)
      : null;
  return resolved && existsSync(resolved) ? resolved : null;
}

function resolveGuides(
  meta: AdapterMeta,
  workspaceRoot: string,
  adapterFile: string | null,
): AdapterGuide[] {
  return adapterGuides(meta).map((specifier) => ({
    specifier,
    path: resolveGuidePath(specifier, workspaceRoot, adapterFile),
  }));
}

export async function loadAdapterCatalog(workspaceRoot: string): Promise<AdapterCatalog> {
  const entries: AdapterCatalogEntry[] = Object.entries(prebuiltAdapters).map(
    ([name, adapter]) => ({
      name,
      importFrom: PREBUILT_IMPORT,
      meta: adapter.meta,
      guides: resolveGuides(adapter.meta, workspaceRoot, null),
    }),
  );
  const errors: AdapterCatalog["errors"] = [];

  const adaptersDir = path.join(workspaceRoot, ADAPTERS_DIR);
  for (const file of await listAdapterFiles(adaptersDir)) {
    const relative = path.relative(workspaceRoot, file);
    let mod: Record<string, unknown>;
    try {
      mod = await importModule(file);
    } catch (error) {
      errors.push({ file: relative, message: error instanceof Error ? error.message : "" });
      continue;
    }

    const importFrom = `konte/workspace/${relative.replaceAll(path.sep, "/").replace(/\.tsx?$/, ".js")}`;
    for (const [name, value] of Object.entries(mod)) {
      if (isAssetAdapter(value)) {
        const guides = resolveGuides(value.meta, workspaceRoot, file);
        // Reported, not fatal: `show` marks the guide missing and prints the rest.
        for (const guide of guides) {
          if (!guide.path) {
            errors.push({ file: relative, message: `guide "${guide.specifier}" has no file` });
          }
        }
        entries.push({ name, importFrom, meta: value.meta, guides });
      }
    }
  }

  entries.sort(
    (a, b) => a.meta.backend.localeCompare(b.meta.backend) || a.name.localeCompare(b.name),
  );
  return { entries, errors };
}

export function filterCatalog(
  entries: AdapterCatalogEntry[],
  filters: { backend?: AdapterBackendKind; kind?: AdapterMeta["mediaType"] },
): AdapterCatalogEntry[] {
  return entries.filter(
    (entry) =>
      (!filters.backend || entry.meta.backend === filters.backend) &&
      (!filters.kind || entry.meta.mediaType === filters.kind),
  );
}

export function requiredInputNames(meta: AdapterMeta): string[] {
  return Object.entries(meta.inputs)
    .filter(([, input]) => input.required)
    .map(([name]) => name);
}
