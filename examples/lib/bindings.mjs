import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const NAMES = ["SLACK_BASE_URL", "SLACK_TOKEN", "GOOGLE_BASE_URL", "GOOGLE_TOKEN",
  "GITHUB_BASE_URL", "GITHUB_TOKEN", "S3_BASE_URL", "SITE_BASE_URL", "SMTP_HOST_PORT", "SMTP_USERNAME",
  "SMTP_PASSWORD", "IMAP_HOST_PORT", "IMAP_USERNAME", "IMAP_PASSWORD", "STRIPE_BASE_URL", "STRIPE_TOKEN"];

export function loadBindings() {
  const stateDir = process.env.WORLDFIXTURE_STATE ?? join(process.cwd(), ".worldfixture/runs/local");
  let recorded = {};
  try {
    recorded = JSON.parse(execFileSync(process.execPath, [join(ROOT, "runtime/bin/worldfixture.mjs"),
      "env", "--json", "--state", stateDir], { cwd: ROOT, encoding: "utf8" }));
  } catch (error) {
    if (!NAMES.every((name) => process.env[name])) throw new Error(`Could not read \`worldfixture env\`: ${error.stderr || error.message}`);
  }
  const bindings = {};
  for (const name of NAMES) bindings[name] = process.env[name] ?? recorded[name];
  const missing = NAMES.slice(0, 8).filter((name) => !bindings[name]);
  if (missing.length) {
    throw new Error(`WorldFixture is not ready (${missing.join(", ")} missing). Run \`npx worldfixture up\` from the application root.`);
  }
  return bindings;
}
