import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
    if (!quiet) process.stdout.write(`  the world could not be rebased onto today, so it starts at its authored anchor: ${detail}\n`);
    return { artifactPath, rebased: false, reason: detail };
  } finally {
    // A failed rollback must leave its backup available for recovery.
    if (!existsSync(previous)) rmSync(temporary, { recursive: true, force: true });
  }
}
