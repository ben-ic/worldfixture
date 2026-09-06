"""Prove P4 content and reverse only recorded changes for historical tests.

The historical-stage build helpers first run the current production compiler,
check every current byte and the domain/source contract, then reverse P4. They
are test adapters, not alternate production compiler entry points. The P4 test
module exercises actual current build and transport artifacts directly.
"""
from __future__ import annotations

import copy
import io
import json
import tarfile
import tempfile
from pathlib import Path

from worldfixture_compiler import build_world, bundle_world
from worldfixture_compiler.compiler import canonical_json, sha256

ROOT = Path(__file__).resolve().parents[2]
P4_MIGRATION = json.loads((Path(__file__).parent / 'coupling-p4-migration.json').read_text())
CONFIG_ARRAYS = {
    ('communication', 'mailboxes'), ('communication', 'bots'), ('communication', 'resolved_mail'),
    ('software', 'queues'), ('software', 'service_roles'), ('software', 'operator_ids'), ('software', 'operator_teams'),
}


def digest(data):
    return {'sha256': sha256(data), 'size': len(data)}


def record_for(world_id, version):
    matches = [row for row in P4_MIGRATION['worlds'] if (row['id'], row['version']) == (world_id, version)]
    assert len(matches) == 1
    return matches[0]


def read_files(directory):
    return {path.relative_to(directory).as_posix(): path.read_bytes() for path in directory.rglob('*') if path.is_file()}


def reverse_source(record, current):
    assert {name: digest(data) for name, data in current.items()} == record['source_files']['to'], 'Current P4 source bytes changed'
    restored = dict(current)
    for name, edits in record['source_edits'].items():
        data = restored[name]
        for edit in reversed(edits):
            offset, after = edit['after_offset'], edit['after'].encode()
            assert data[offset:offset + len(after)] == after, f'Exact P4 source edit absent: {name}'
            data = data[:offset] + edit['before'].encode() + data[offset + len(after):]
        restored[name] = data
    assert {name: digest(data) for name, data in restored.items()} == record['source_files']['from'], 'Original P4 source bytes not reproduced'
    return restored


def historical_source_bytes(world_id, version, source_root=ROOT):
    record = record_for(world_id, version)
    directory = source_root / Path(record['source']).parent
    current = {name: (directory / name).read_bytes() for name in record['source_files']['to']}
    if {name: digest(data) for name, data in current.items()} == record['source_files']['from']:
        return current
    return reverse_source(record, current)


def assert_domain_semantics(files):
    """Independently enumerate source record arrays; never call projection code."""
    world = json.loads(files['world.json'])
    domain = json.loads(files['projections/domain.json'])
    expected = {}
    for name, data in files.items():
        if not name.startswith('packs/'):
            continue
        section = Path(name).stem
        for field, rows in json.loads(data).items():
            if (section, field) in CONFIG_ARRAYS or not isinstance(rows, list):
                continue
            if all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in rows):
                assert len({row['id'] for row in rows}) == len(rows)
                expected[f'{section}.{field}'] = rows
    assert domain == {'api_version': 'worldfixture.domain/v1', 'world': {'id': world['id'], 'version': world['version']}, 'collections': expected}, 'Domain records differ from canonical packs'
    # The source tree is authoritative. Ignore only compiler-derived expansion
    # fields; the finance migration suite proves those expanded values separately.
    from tests.parity.finance_migration import merge_source
    record = record_for(world['id'], world['version'])
    source_files = {name: (ROOT / Path(record['source']).parent / name).read_bytes() for name in record['source_files']['to']}
    reverse_source(record, source_files)
    source = merge_source(source_files)
    canonical = copy.deepcopy(world)
    canonical.get('finance', {}).pop('resolved', None)
    canonical.get('communication', {}).pop('resolved_mail', None)
    assert canonical == source, 'Canonical world differs from authored source'
    identity = json.loads(files['packs/identity.json'])
    assert identity['people'] == world['people']
    assert identity['organizations'] == world['organizations']
    overlay = json.loads(files['projections/emulator-overlay.json'])
    software, communication = world.get('software', {}), world.get('communication', {})
    absent = []
    if not software.get('oauth_clients', {}).get('apple'):
        absent.append('apple')
    if 'database' not in software:
        absent.append('mongoatlas')
    if 'twilio' not in communication:
        absent.append('twilio')
    if 'repositories' not in software:
        absent += [provider for provider in ('github', 'vercel') if provider not in software.get('oauth_clients', {})]
    for provider in absent:
        assert f'projections/{provider}.json' not in files
        assert provider not in overlay
        assert f'{provider}_token' not in overlay.get('tokens', {})
    if 'site' not in world:
        assert 'projections/http-targets.json' not in files
    if world['id'] == 'consumer.retail-brand':
        assert 'repositories' not in software and 'time_entries' not in world['work']
        assert all('github_login' not in person and 'slack_id' not in person for person in world['people'])


def reverse_json(document, edits):
    result = copy.deepcopy(document)
    for edit in reversed(edits):
        path = edit['path']
        assert path, 'Whole-file replacements are forbidden'
        parent = result
        for key in path[:-1]:
            parent = parent[key]
        key = path[-1]
        if 'after' in edit:
            assert parent[key] == edit['after'], f'P4 changed value drifted: {path}'
            if 'before' in edit:
                parent[key] = copy.deepcopy(edit['before'])
            elif isinstance(parent, list):
                parent.pop(key)
            else:
                del parent[key]
        elif isinstance(parent, list):
            parent.insert(key, copy.deepcopy(edit['before']))
        else:
            assert key not in parent
            parent[key] = copy.deepcopy(edit['before'])
    return result


def reverse_p4(files):
    world = json.loads(files['world.json'])
    record = record_for(world['id'], world['version'])
    assert_domain_semantics(files)
    assert {name: digest(data) for name, data in files.items()} == record['after_files'], 'Current P4 artifact bytes changed'
    restored = dict(files)
    assert record['added_files'] == ['projections/domain.json']
    restored.pop('projections/domain.json')
    for name, value in record['removed_files'].items():
        assert name in {f'projections/{provider}.json' for provider in ('apple', 'github', 'vercel', 'mongoatlas', 'twilio', 'http-targets')}
        assert name not in restored
        restored[name] = canonical_json(value)
    for name, edits in record['json_edits'].items():
        restored[name] = canonical_json(reverse_json(json.loads(files[name]), edits))
    assert {name: digest(data) for name, data in restored.items()} == record['before_files'], 'Original P4 artifact bytes not reproduced'
    return restored


def historical_files(files):
    if 'projections/domain.json' in files:
        return reverse_p4(files)
    return files


def pack_files(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, content in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(content), 0o644, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def build_historical_finance_stage(source, output):
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        build_world(source, directory)
        files = reverse_p4(read_files(directory))
    for name, data in files.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return json.loads(files['manifest.json'])


def bundle_historical_finance_stage(source, output):
    with tempfile.TemporaryDirectory() as temporary:
        current = Path(temporary) / 'current.tar'
        bundle_world(source, current)
        with tarfile.open(current) as archive:
            files = {member.name: archive.extractfile(member).read() for member in archive.getmembers()}
        # Prove current transport metadata, ordering, and padding before reversal.
        assert current.read_bytes() == pack_files(files)
        files = reverse_p4(files)
    data = pack_files(files)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    manifest = json.loads(files['manifest.json'])
    return {'world_id': manifest['world_id'], 'world_version': manifest['world_version'],
            'content_sha256': manifest['artifact_sha256'], 'artifact_sha256': sha256(data), 'artifact_size': len(data)}
