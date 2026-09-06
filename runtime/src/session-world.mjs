import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { shareHostArtifact } from './host-state-ownership.mjs';
import { inspectWorldArtifact } from "./world-catalogue.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Find source by its declared hashes. A staged or renamed artifact has the
// same provenance as its original. Build and verify before replacing a session.
export function rebaseForSession(artifactPath, stateDir, {
  quiet = false,
  sourceRoots = [join(ROOT, "worlds")],
  runCompiler = execFileSync,
} = {}) {
  const selected = inspectWorldArtifact(artifactPath, { sourceRoots });
  if (!selected.sourcePath) return { artifactPath, rebased: false, reason: "this install ships no world source verified for the selected artifact" };
  if (!selected.valid) return { artifactPath, rebased: false, reason: `invalid world artifact: ${selected.errors.join("; ")}` };

  mkdirSync(stateDir, { recursive: true });
  const temporary = mkdtempSync(join(stateDir, ".rebase-"));
  const prepared = join(temporary, "world");
  const previous = join(temporary, "previous");
  const output = join(stateDir, "world");
  const script = "from datetime import datetime, timezone; from pathlib import Path; " +
    "from worldfixture_compiler.compiler import build_rebased_world; " +
    `build_rebased_world(Path(${JSON.stringify(selected.sourcePath)}), datetime.now(timezone.utc), Path(${JSON.stringify(prepared)}))`;
  try {
    runCompiler("python3", ["-c", script], {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: join(ROOT, "compiler") },
      stdio: "pipe",
      timeout: 120_000,
    });
    const checked = inspectWorldArtifact(prepared);
    if (!checked.valid || checked.id !== selected.id || checked.version !== selected.version) {
      throw new Error(`Rebased artifact failed validation: ${checked.errors.join("; ") || "world identity changed"}`);
    }
    if (checked.manifest.source_sha256 !== selected.manifest.source_sha256 ||
        !isDeepStrictEqual(checked.manifest.source_files, selected.manifest.source_files)) {
      throw new Error("World source changed after artifact selection");
    }
    shareHostArtifact(prepared);
    if (existsSync(output)) renameSync(output, previous);
    try { renameSync(prepared, output); }
    catch (error) {
      if (existsSync(previous)) renameSync(previous, output);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return { artifactPath: output, rebased: true };
  } catch (error) {
    // Preserve the original input and previous session when compilation fails.
    const detail = String(error.stderr ?? error.message).trim().split("\n").pop();
    const repair = repairFor(error, detail);
    if (!quiet) {
      process.stdout.write(`  the world could not be rebased onto today, so it starts at its authored anchor: ${detail}\n`);
      if (repair) process.stdout.write(`  ${repair}\n`);
    }
    return { artifactPath, rebased: false, reason: detail, repair };
  } finally {
    // A failed rollback must leave its backup available for recovery.
    if (!existsSync(previous)) rmSync(temporary, { recursive: true, force: true });
  }
}

// The one repair for a rebase that could not run at all.
//
// THE FAILURE THIS NAMES. A checkout without the compiler's Python dependency
// installed reported `ModuleNotFoundError: No module named 'jsonschema'` and
// nothing else, on a line about world dates. The world then started sixteen
// days behind today, four unrelated-looking tests failed, and nowhere did
// anything say which command fixes it. Every other failure in this CLI names a
// component, a cause and one repair; this one named a Python traceback.
//
// Only the causes that have a single certain repair are named. A compiler that
// ran and rejected the source is a different problem and gets no advice.
export function repairFor(error, detail = String(error?.stderr ?? error?.message ?? "")) {
  if (error?.code === "ENOENT") {
    return "python3 is not on PATH. The world compiler needs Python 3.11 or newer to rebase a world onto today.";
  }
  const missing = /No module named '([^']+)'/.exec(detail);
  if (missing) {
    return `The world compiler is missing its ${missing[1]} dependency. Install it with \`python3 -m pip install -r requirements.txt\`.`;
  }
  return null;
}
