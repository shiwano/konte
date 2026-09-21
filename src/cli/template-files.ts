import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function writeTemplateFiles(
  dir: string,
  files: Record<string, string>,
  binary: ReadonlySet<string>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([filePath, content]) => {
      const fullPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      if (binary.has(filePath)) {
        return fs.writeFile(fullPath, Buffer.from(content, "base64"));
      }
      return fs.writeFile(fullPath, content, "utf-8");
    }),
  );
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
