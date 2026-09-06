import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./worldfixture-entrypoint.sh', import.meta.url));
const source = readFileSync(path, 'utf8');

test('PostgreSQL entrypoint remains valid POSIX shell', () => {
  assert.doesNotThrow(() => execFileSync('sh', ['-n', path]));
});

test('published PostgreSQL access requires SCRAM for IPv4 and IPv6', () => {
  const rules = [...source.matchAll(/^\s*'(host[^']+)'/gm)].map(match => match[1]);
  assert.deepEqual(rules, [
    'host all all 0.0.0.0/0 scram-sha-256',
    'host all all ::/0 scram-sha-256',
  ]);
  assert.ok(rules.every(rule => rule.endsWith('scram-sha-256')));
  assert.match(source, /'local all all trust'/, 'Keep the existing local socket behavior.');
  assert.match(source, /-c "password_encryption=scram-sha-256"/);
});

test('authentication policy is regenerated outside initdb and passed explicitly', () => {
  const initEnd = source.indexOf('\nfi\n');
  const generate = source.indexOf('hba_file="$state/pg_hba.conf"');
  assert.ok(initEnd > 0 && generate > initEnd, 'Existing databases must receive the same TCP policy on restart.');
  assert.match(source, /mktemp "\$state\/\.pg_hba\.XXXXXX"/);
  assert.match(source, /chmod 0600 "\$hba_temporary"/);
  assert.match(source, /chown postgres:postgres "\$hba_temporary"/);
  assert.match(source, /mv -f "\$hba_temporary" "\$hba_file"/);
  assert.match(source, /-c "hba_file=\$hba_file"/);
});
