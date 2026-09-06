import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'node_modules/worldfixture/package.json'), 'utf8'));
assert.equal(pkg.name, 'worldfixture');
const temporary = mkdtempSync(join(tmpdir(), 'account-desk-installed-'));
const bin = join(root, 'node_modules/worldfixture', pkg.bin.worldfixture);
const result = execFileSync(process.execPath, [bin, '--help'], { cwd: temporary, encoding: 'utf8' });
assert.match(result, /worldfixture run/);
assert.match(result, /worldfixture env/);
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(mjs|js|jsx|ts|tsx)$/.test(file)) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /(?:import|from)\s*[^\n]*['"][^'"\n]*(?:runtime\/src|runtime\/bin|examples\/lib)/, file);
      assert.doesNotMatch(text, /host-bindings\.json|instance\.json/, file);
    }
  }
}
check(join(root, 'src'));
console.log(`Installed WorldFixture ${pkg.version} runs outside the checkout. No private runtime imports found.`);
console.log('This check proves package resolution and CLI availability, not a complete live application workflow.');
