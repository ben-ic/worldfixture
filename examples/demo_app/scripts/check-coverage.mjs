import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { coverageReport } from '../src/verification/coverage-report.mjs';

const actual = await readFile(new URL('../COVERAGE.md', import.meta.url), 'utf8');
assert.equal(actual, coverageReport(), 'COVERAGE.md differs from the app registry. Regenerate it from coverageReport().');
console.log('Coverage documentation matches the app registry. Provider coverage tests check action and evidence references.');
