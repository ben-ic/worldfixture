// @emulators/core 0.10.0 has no public rate-limit option. This measured local
// change raises its existing bucket; it does not add middleware or change auth.
// Exact input/output hashes make a dependency change fail until it is reviewed.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CORE_VERSION = '0.10.0';
export const ORIGINAL_SHA256 = 'e3adc422e572e966895b20e28f87c1bf2e643578f8ab2f1869450b24834d95e0';
export const PATCHED_SHA256 = 'b62becb5e5440db87111d25559c2eccae6587e571f293a670b2635f794c89a3d';
const hash = value => createHash('sha256').update(value).digest('hex');

export function patchCoreSource(source, version) {
  if (version !== CORE_VERSION) throw new Error(`Rate-limit patch requires @emulators/core ${CORE_VERSION}; found ${version}. Review the upstream change before installing.`);
  const digest = hash(source);
  if (digest === PATCHED_SHA256) return source;
  if (digest !== ORIGINAL_SHA256) throw new Error('Rate-limit patch refused: core source does not match the reviewed bytes.');
  const updated = source
    .replace('counter = { remaining: 5e3, resetAt: now + 3600 };', 'counter = { remaining: 1e5, resetAt: now + 3600 };')
    .replace('c.header("X-RateLimit-Limit", "5000");', 'c.header("X-RateLimit-Limit", "100000");');
  if (hash(updated) !== PATCHED_SHA256) throw new Error('Rate-limit patch produced unexpected bytes.');
  return updated;
}

export function applyCoreRateLimit() {
  const packageUrl = new URL('../node_modules/@emulators/core/package.json', import.meta.url);
  const sourceUrl = new URL('../node_modules/@emulators/core/dist/index.js', import.meta.url);
  const { version } = JSON.parse(readFileSync(packageUrl, 'utf8'));
  const source = readFileSync(sourceUrl, 'utf8');
  const updated = patchCoreSource(source, version);
  if (updated !== source) writeFileSync(sourceUrl, updated);
  return updated !== source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`[worldfixture] core local rate budget 100000/hour: ${applyCoreRateLimit() ? 'applied' : 'already applied'}`);
}
