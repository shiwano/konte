import { format } from "oxfmt";
import { KonteError } from "./errors.js";

// A generated doc as `oxfmt --check` expects it.
export async function formatGeneratedDoc(file: string, markdown: string): Promise<string> {
  const { code, errors } = await format(file, markdown);
  if (errors.length > 0) {
    throw new KonteError("INTERNAL_ERROR", `oxfmt failed on ${file}: ${JSON.stringify(errors)}`);
  }
  return code;
}
