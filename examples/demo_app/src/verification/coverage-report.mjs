import { ACTIONS } from '../providers/index.mjs';
import { COVERAGE_BASELINE, PROVIDER_COVERAGE, UNIMPLEMENTED_WORKFLOWS } from '../providers/coverage.mjs';

const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
export function coverageReport() {
  const lines = ['# Account Desk service coverage', '',
    'This file is generated from the same registry that the app shows. It records',
    'named local workflows, not the full API of each production provider.', '',
    `Reference check: ${COVERAGE_BASELINE.checkedDate}, ${COVERAGE_BASELINE.world}.`,
    `Corrected image: \`${COVERAGE_BASELINE.advancedImageId}\`.`, '',
    'A reference test is not a result for your running world. Use Verification to',
    'check the current connections and approved writes. No production-provider',
    'equivalence is claimed.', '',
    '| Service | App writes | SDK or client version |', '| --- | --- | --- |'];
  for (const entry of PROVIDER_COVERAGE) lines.push(`| ${entry.service} | ${entry.actionIds.length ? entry.actionIds.map(id => cell(ACTIONS.find(action => action.id === id)?.name || id)).join('; ') : 'No app write workflow'} | ${cell(entry.testedSDKVersion ? Object.entries(entry.testedSDKVersion).map(([name, version]) => `${name}: ${version}`).join('; ') : 'HTTP/protocol reads; no official SDK claim')} |`);
  for (const entry of PROVIDER_COVERAGE) {
    lines.push('', `## ${entry.service}`, '', 'Reads used by the app:', '', ...entry.readOperations.map(operation => `- \`${operation}\``), '', 'Writes used by the app:', '');
    if (!entry.actionIds.length) lines.push('No write workflow is implemented in Account Desk for this service.');
    for (const id of entry.actionIds) {
      const action = ACTIONS.find(item => item.id === id);
      lines.push(`- **${action.name}** (\`${id}\`): ${entry.actionStatus[id]} locally. Inputs: ${action.fields.map(field => `\`${field.name}\`${field.required === false ? ' (optional)' : ''}`).join(', ')}.${action.kind === 'local-verification' ? ' Subscription setup is Workbench-only; this is not a public provider operation.' : ''}`);
    }
    lines.push('', 'Limits:', '', ...entry.gaps.map(gap => `- ${gap}`), '', 'Evidence:', '', ...entry.tests.map(path => `- \`${path}\``));
  }
  lines.push('', '## Exclusions and checks not yet run', '',
    'These entries do not mean that Notion is broken. Its REST, MCP, Agent, Admin,',
    'and signed local capture workflows are listed above. A separate sample app,',
    'a provider-local adapter, and outbound network delivery have different limits.', '');
  for (const entry of UNIMPLEMENTED_WORKFLOWS) lines.push(`- **${entry.workflow}** — ${entry.status === 'unsupported' ? 'Not available through this app’s supported interfaces' : 'Not included in the verified app workflows'}. ${entry.reason}`);
  lines.push('', 'PostgreSQL and MariaDB app storage are checked separately. See', '[Database checks](DATABASE_TESTS.md). For the complete installed-package test,', 'see [First-run checks](FIRST_RUN_TESTS.md).', '');
  return lines.join('\n');
}
