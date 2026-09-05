import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docs = join(root, "docs");
const allowedLabels = new Set([
  "Supported and contract-tested",
  "Supported but partial",
  "Workbench-only",
  "Not supported",
  "Not verified against the production provider",
]);
const failures = [];

const vitePressConfig = readFileSync(join(docs, ".vitepress/config.mjs"), "utf8");
if (!vitePressConfig.includes('process.env.DOCS_BASE ?? "/docs/"')) {
  failures.push("docs/.vitepress/config.mjs: embedded docs must default to /docs/");
}

function filesBelow(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const target = join(path, entry.name);
    if (entry.name === "node_modules" || entry.name === ".vitepress") return [];
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

function withoutAnchor(value) {
  return decodeURIComponent(value.split("#")[0].split("?")[0]);
}

for (const file of filesBelow(docs).filter((path) => extname(path) === ".md")) {
  const text = readFileSync(file, "utf8");
  const isProviderPage = dirname(file) === join(docs, "providers");
  const isPolicyOrIndex = ["index.md", "support-policy.md"].includes(relative(dirname(file), file));
  if (isProviderPage && !isPolicyOrIndex && text.includes("Supported but partial")) {
    if (!/^## What works$/m.test(text)) {
      failures.push(`${relative(root, file)}: partial support needs a \"What works\" section`);
    }
    if (!/^## What does not work$/m.test(text)) {
      failures.push(`${relative(root, file)}: partial support needs a \"What does not work\" section`);
    }
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].trim().replace(/^<|>$/g, "");
    if (!href || /^(?:https?:|mailto:|#)/.test(href) || href.includes("${")) continue;
    const clean = withoutAnchor(href);
    const target = clean.startsWith("/") ? join(docs, clean) : resolve(dirname(file), clean);
    const candidates = [
      target,
      `${target}.md`,
      join(target, "index.md"),
      ...(clean.startsWith("/") ? [join(docs, "public", clean)] : []),
    ];
    if (!candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile())) {
      failures.push(`${relative(root, file)}: missing link target ${href}`);
    }
  }
}

const architecture = readFileSync(join(docs, "architecture.md"), "utf8");
const docsPackage = readFileSync(join(docs, "package.json"), "utf8");
if (architecture.includes("```mermaid")) failures.push("docs/architecture.md: Mermaid source is not allowed");
if (docsPackage.includes("mermaid")) failures.push("docs/package.json: Mermaid is not required for static D2 diagrams");
for (const name of ["containers"]) {
  const source = join(docs, "architecture", `${name}.d2`);
  const asset = join(docs, "public", "architecture", `${name}.svg`);
  if (!existsSync(source)) failures.push(`docs/architecture/${name}.d2: missing D2 source`);
  if (!existsSync(asset)) {
    failures.push(`docs/public/architecture/${name}.svg: missing generated diagram`);
    continue;
  }
  const svg = readFileSync(asset, "utf8");
  if (!svg.includes("<svg") || !svg.includes("viewBox=")) failures.push(`${relative(root, asset)}: invalid SVG`);
  if (svg.includes("<script") || /(?:href|src)=["']https?:/i.test(svg)) {
    failures.push(`${relative(root, asset)}: diagram must be safe and work offline`);
  }
}

const matrixPath = join(docs, "providers/support-matrix.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
for (const [kind, records] of Object.entries(matrix)) {
  for (const [name, record] of Object.entries(records)) {
    for (const path of [record.page, ...(record.tests ?? [])]) {
      if (!existsSync(join(root, path))) failures.push(`${kind}.${name}: missing reference ${path}`);
    }
    const page = readFileSync(join(root, record.page), "utf8");
    for (const label of record.labels ?? []) {
      if (!allowedLabels.has(label)) failures.push(`${kind}.${name}: invalid label ${label}`);
      if (!page.includes(label)) failures.push(`${kind}.${name}: page does not contain label ${label}`);
    }
  }
}

const manifest = JSON.parse(readFileSync(join(root, "emulators/emulate/service.json"), "utf8"));
const registeredProviders = new Set(manifest.provides.map((entry) => entry.profile.split(".")[0]));
for (const provider of registeredProviders) {
  if (!matrix.providers[provider]) failures.push(`provider.${provider}: no support-matrix record`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Documentation checks passed for ${Object.keys(matrix.providers).length} providers and ${Object.keys(matrix.services).length} services.`);
