import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function removePathSafely(p: string): Promise<boolean> {
  try {
    await fs.rm(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function getPathSize(p: string): Promise<number> {
  try {
    const stat = await fs.stat(p);
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) {
      let total = 0;
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const entry of entries) {
        total += await getPathSize(path.join(p, entry.name));
      }
      return total;
    }
    return 0;
  } catch {
    return 0;
  }
}
