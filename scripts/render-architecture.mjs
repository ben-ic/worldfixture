import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const image = "d2lang/d2:v0.7.1";
const diagrams = ["containers", "system"];
const temporary = check ? mkdtempSync(join(tmpdir(), "worldfixture-d2-")) : null;
const outputDirectory = temporary ?? join(root, "docs/public/architecture");

mkdirSync(outputDirectory, { recursive: true });

try {
  for (const name of diagrams) {
    const source = `docs/architecture/${name}.d2`;
    const output = check
      ? join(outputDirectory, `${name}.svg`)
      : `docs/public/architecture/${name}.svg`;
    const containerOutput = check ? `/output/${name}.svg` : output;
    const args = [
      "run",
      "--rm",
      "-u",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-v",
      `${root}:/src`,
    ];
    if (check) args.push("-v", `${outputDirectory}:/output`);
    args.push(
      "-w",
      "/src",
      image,
      "--layout=elk",
      "--theme=303",
      "--dark-theme=200",
      "--pad=40",
      source,
      containerOutput,
    );

    const result = spawnSync("docker", args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);

    if (check) {
      const committed = readFileSync(join(root, "docs/public/architecture", `${name}.svg`));
      const generated = readFileSync(output);
      if (!committed.equals(generated)) {
        console.error(`${name}.svg is not equal to ${name}.d2; run npm run docs:diagrams`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}

if (!process.exitCode) {
  console.log(check ? "Architecture SVG files match their D2 sources." : "Architecture SVG files rendered.");
}
