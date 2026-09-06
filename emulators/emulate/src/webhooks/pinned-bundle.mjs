import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Some pinned CLI providers expose no delivery hook. Patch only their in-memory
// module, never global fetch or node_modules. Any source drift stops the import.
export async function importPatchedProvider({ url, sha256, replacements, prelude = "" }) {
  const source = await readFile(new URL(url), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== sha256) {
    throw new Error(`Provider webhook adapter source changed: ${new URL(url).pathname}; review the adapter before updating its hash`);
  }
  let patched = source;
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error("Provider webhook adapter expected exactly one source match");
    patched = patched.replace(before, after);
  }
  // Preserve file-relative imports and asset resolution from the original module.
  patched = patched.replace(/from (["'])(\.{1,2}\/[^"']+)\1/g,
    (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`)
    .replace(/\bimport (["'])(\.{1,2}\/[^"']+)\1/g,
      (_match, _quote, specifier) => `import ${JSON.stringify(new URL(specifier, url).href)}`)
    .replaceAll("import.meta.url", JSON.stringify(url));
  return import(`data:text/javascript;base64,${Buffer.from(prelude + patched).toString("base64")}`);
}
