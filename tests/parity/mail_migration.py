"""Independent source semantics and byte reversal for the reviewed mail migration."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from worldfixture_compiler.compiler import canonical_json, sha256

from tests.parity.finance_migration import finance_record, finance_source_evidence, write_pre_finance_sources

ROOT = Path(__file__).resolve().parents[2]
MAIL_MIGRATION = json.loads((Path(__file__).parent / 'coupling-mail-migration.json').read_text())
MAIL_FILES = {'manifest.json', 'world.json', 'packs/communication.json', 'projections/google.json', 'projections/emulator-overlay.json'}
GOOGLE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.modify']


def digest(data: bytes) -> dict:
    return {'sha256': sha256(data), 'size': len(data)}


def mail_record(world_id: str, version: str) -> dict:
    rows = [row for row in MAIL_MIGRATION['worlds'] if (row['id'], row['version']) == (world_id, version)]
    assert len(rows) == 1, 'Each identity requires one reviewed mail migration'
    return rows[0]


def mail_source_evidence(record: dict, source_root: Path = ROOT) -> dict:
    """Remove the exact fragment-list insertion; hash actual restored source bytes."""
    directory = source_root / Path(record['source']).parent
    manifest = json.loads((source_root / record['source']).read_bytes())
    current = (finance_source_evidence(finance_record(record['id'], record['version']), source_root)['before_bytes']
               if 'packs/finance-settlements.json' in manifest.get('fragments', [])
               else {name: (directory / name).read_bytes() for name in record['source_files']['to']})
    assert {name: digest(data) for name, data in current.items()} == record['source_files']['to'], 'Current mail source bytes changed'
    name = Path(record['source']).name
    document = json.loads(current[name])
    assert document['api_version'] == 'worldfixture.world-manifest/v1'
    assert (document['world']['id'], document['world']['version']) == (record['id'], record['version'])
    assert set([name, *document['fragments']]) == set(current)
    assert len(document['fragments']) == len(set(document['fragments']))
    added = record['added_source_file']
    assert set(current) - set(record['source_files']['from']) == {added}
    insertion = record['source_manifest_insertion'].encode()
    assert insertion == b',\n    "packs/google-mailboxes.json"'
    assert current[name].count(insertion) == 1
    before = {key: data for key, data in current.items() if key != added}
    before[name] = current[name].replace(insertion, b'', 1)
    restored = json.loads(before[name])
    expected = copy.deepcopy(document)
    assert expected['fragments'].pop() == added
    assert restored == expected, 'Only the mailbox fragment-list entry may change'
    assert {key: digest(data) for key, data in before.items()} == record['source_files']['from'], 'Original source bytes not reproduced'
    fragment = json.loads(current[added])
    assert set(fragment) == {'api_version', 'id', 'contributes'}
    assert fragment['api_version'] == 'worldfixture.world-fragment/v1'
    assert fragment['id'] == 'pack.google-mailboxes'
    assert set(fragment['contributes']) == {'communication'}
    assert set(fragment['contributes']['communication']) == {'mailboxes'}
    mailboxes = fragment['contributes']['communication']['mailboxes']
    assert [row['owner_id'] for row in mailboxes] == record['mailbox_owner_ids']
    for generation, content in [('before', before), ('after', current)]:
        expected_sha = record['from_source_sha256'] if generation == 'before' else record['to_source_sha256']
        assert sha256(canonical_json({key: digest(data) for key, data in content.items()})) == expected_sha
    return {'before_bytes': before, 'after_bytes': current, 'mailboxes': mailboxes}


def write_pre_mail_sources(record: dict, source_root: Path) -> None:
    if 'packs/finance-settlements.json' in json.loads((source_root / record['source']).read_bytes()).get('fragments', []):
        write_pre_finance_sources(finance_record(record['id'], record['version']), source_root)
    evidence = mail_source_evidence(record, source_root)
    directory = source_root / Path(record['source']).parent
    for name, data in evidence['before_bytes'].items():
        (directory / name).write_bytes(data)
    (directory / record['added_source_file']).unlink()


def message_fields(world: dict, message: dict) -> dict:
    people = {row['id']: row for row in world['people']}

    def address(person):
        return f"{person['name']} <{person['email']}>"

    return {'id': message['id'], 'thread_id': message['thread_id'],
            'from': address(people[message['from_id']]),
            'to': ', '.join(address(people[person]) for person in message['to_ids']),
            'subject': message['subject'], 'snippet': message['snippet'], 'body_text': message['body_text'],
            'label_ids': message['labels'], 'date': message['sent_at'],
            'worldfixture_entity_refs': {key: message[key] for key in ('invoice_id', 'customer_id', 'order_id') if key in message}}


def expected_google(world: dict, *, legacy: bool = False) -> dict:
    people = {row['id']: row for row in world['people']}
    primary = next(row for row in world['people'] if row.get('primary'))
    mailboxes = world['communication'].get('mailboxes', [])
    selected = {row['owner_id'] for row in mailboxes}
    messages = []
    for message in world['communication']['resolved_mail']:
        common = message_fields(world, message)
        if legacy:
            if primary['id'] == message['from_id'] or primary['id'] in message['to_ids']:
                messages.append(common)
        else:
            owners = set(message['to_ids'])
            if 'SENT' in message['labels']:
                owners.add(message['from_id'])
            for owner in sorted(owners & selected):
                identity = json.dumps([world['id'], world['version'], owner, message['id']], ensure_ascii=False, separators=(',', ':')).encode()
                messages.append({**common, 'id': 'wf_' + sha256(identity)[:32],
                                 'worldfixture_message_id': message['id'], 'worldfixture_owner_id': owner,
                                 'user_email': people[owner]['email']})
    users = [{'email': row['email'], 'name': row['name'], 'email_verified': True,
              **({} if legacy else {'worldfixture_person_id': row['id']})}
             for row in world['people'] if row['id'] in ({primary['id']} if legacy else selected)]
    docs = copy.deepcopy(world['communication'].get('documents', []))
    if not legacy:
        for document in docs:
            document.update({'worldfixture_document_id': document['id'], 'worldfixture_owner_id': document['owner_id'],
                             'user_email': people[document['owner_id']]['email'],
                             'name': document.get('name') or document.get('title') or document['id'],
                             'mime_type': document.get('mime_type', 'text/markdown'),
                             'data': document.get('content', document.get('body_md', document.get('body', '')))})
    result = {'users': users, 'messages': sorted(messages, key=lambda row: (row['date'], row['id'])), 'drive_items': docs}
    if not legacy:
        result['labels'] = [{'id': label, 'name': label, 'user_email': people[row['owner_id']]['email'], 'type': 'user'}
                            for row in mailboxes for label in row['labels']]
    return result


def expected_arrivals(world: dict, *, legacy: bool = False) -> list:
    people = {row['id']: row for row in world['people']}
    arrivals = []
    for event in world['timeline']:
        if event['kind'] != 'incoming-email':
            continue
        payload = event['payload']
        if not legacy and payload.get('via', 'smtp') != 'gmail':
            continue
        sender, recipient = people[payload['from_id']], people[payload['to_id']]
        arrival = {'after_seconds': event['after_seconds'], 'message': {
            'id': event['id'], 'thread_id': payload.get('thread_id', f"thread-{event['id']}"),
            'from': f"{sender['name']} <{sender['email']}>", 'to': recipient['email'],
            'subject': payload['subject'], 'snippet': payload['snippet'], 'body_text': payload['body_text'],
            'label_ids': payload.get('labels', ['INBOX', 'UNREAD'])}}
        if not legacy:
            arrival.update({'via': 'gmail', 'worldfixture_owner_id': recipient['id'], 'user': recipient['email'],
                            'token_ref': f"google_token_{recipient['id']}"})
        arrivals.append(arrival)
    return arrivals


def assert_mail_semantics(case, files: dict[str, bytes], source_root: Path = ROOT) -> None:
    world = json.loads(files['world.json'])
    record = mail_record(world['id'], world['version'])
    evidence = mail_source_evidence(record, source_root)
    case.assertIn('mailboxes', world['communication'], 'Artifact must include the approved mailbox declarations')
    case.assertEqual(evidence['mailboxes'], world['communication']['mailboxes'])
    case.assertEqual(evidence['mailboxes'], json.loads(files['packs/communication.json'])['mailboxes'])
    expected = expected_google(world)
    google = json.loads(files['projections/google.json'])
    overlay = json.loads(files['projections/emulator-overlay.json'])
    for key, value in expected.items():
        case.assertEqual(value, google[key], f'Google {key} must preserve every source owner and field')
    expected_overlay = copy.deepcopy(google)
    expected_overlay['worldfixture_seed_version'] = 1
    for message in expected_overlay['messages']:
        message.pop('worldfixture_entity_refs')
    case.assertEqual(expected_overlay, overlay['google'])
    owners = {row['owner_id'] for row in evidence['mailboxes']}
    tokens = {f"google_token_{person['id']}": {'login': person['email'], 'scopes': GOOGLE_SCOPES}
              for person in world['people'] if person['id'] in owners}
    case.assertEqual(tokens, {key: value for key, value in overlay['tokens'].items() if key.startswith('google_token_')})
    primary = next(row for row in world['people'] if row.get('primary'))
    case.assertEqual({'login': primary['email'], 'scopes': GOOGLE_SCOPES} if primary['id'] in owners else None, overlay['tokens'].get('demo_token'))
    case.assertEqual(1, overlay['linear']['worldfixture_seed_version'])
    tasks = world['work']['tasks']
    issues = overlay['linear']['issues']
    case.assertEqual([row['id'] for row in tasks], [row['worldfixture_task_id'] for row in issues])
    case.assertEqual([row['project_id'] for row in tasks], [row['worldfixture_project_id'] for row in issues])
    case.assertEqual(expected_arrivals(world), overlay['worldfixture']['arrivals'])
    manifest = json.loads(files['manifest.json'])
    case.assertEqual(record['source_files']['to'], manifest['source_files'])
    case.assertEqual(record['to_source_sha256'], manifest['source_sha256'])
    table = {name: digest(data) for name, data in files.items() if name != 'manifest.json'}
    case.assertEqual(table, manifest['files'])
    case.assertEqual(record['to_artifact_sha256'], sha256(canonical_json(table)))
    case.assertEqual(record['to_artifact_sha256'], manifest['artifact_sha256'])


def reverse_mail_projection_changes(files: dict[str, bytes]) -> dict[str, bytes]:
    """Reverse only the compiler's mail/Drive/Linear transforms, retaining provenance.

    Also used for the older operator compatibility test, whose source already
    has both source declarations removed. The caller must prove source bytes.
    """
    restored = dict(files)
    world = json.loads(files['world.json'])
    legacy = expected_google(world, legacy=True)
    for name in ('projections/google.json', 'projections/emulator-overlay.json'):
        document = json.loads(files[name])
        google = document if name.endswith('/google.json') else document['google']
        google.pop('labels')
        google.update(copy.deepcopy(legacy))
        if 'google' in document:
            assert google.pop('worldfixture_seed_version') == 1
            for message in google['messages']:
                message.pop('worldfixture_entity_refs')
            assert document['linear'].pop('worldfixture_seed_version') == 1
            for issue in document['linear']['issues']:
                issue.pop('worldfixture_task_id')
                issue.pop('worldfixture_project_id')
            for key in list(document['tokens']):
                if key.startswith('google_token_'):
                    del document['tokens'][key]
            primary = next(row for row in world['people'] if row.get('primary'))
            document['tokens']['demo_token'] = {'login': primary['email'], 'scopes': GOOGLE_SCOPES}
            document['worldfixture']['arrivals'] = expected_arrivals(world, legacy=True)
        restored[name] = canonical_json(document)
    manifest = json.loads(restored['manifest.json'])
    for name in ('projections/google.json', 'projections/emulator-overlay.json'):
        manifest['files'][name] = digest(restored[name])
    manifest['artifact_sha256'] = sha256(canonical_json(manifest['files']))
    restored['manifest.json'] = canonical_json(manifest)
    return restored


def reverse_mail_migration(files: dict[str, bytes], source_root: Path = ROOT) -> dict[str, bytes]:
    restored = reverse_mail_projection_changes(files)
    world = json.loads(files['world.json'])
    record = mail_record(world['id'], world['version'])
    evidence = mail_source_evidence(record, source_root)
    communication = json.loads(files['packs/communication.json'])
    for node in (world['communication'], communication):
        assert node.pop('mailboxes') == evidence['mailboxes']
    restored['world.json'] = canonical_json(world)
    restored['packs/communication.json'] = canonical_json(communication)
    manifest = json.loads(restored['manifest.json'])
    table = {name: digest(data) for name, data in evidence['before_bytes'].items()}
    manifest['source_files'] = table
    manifest['source_sha256'] = sha256(canonical_json(table))
    for name in MAIL_FILES - {'manifest.json'}:
        manifest['files'][name] = digest(restored[name])
    manifest['artifact_sha256'] = sha256(canonical_json(manifest['files']))
    restored['manifest.json'] = canonical_json(manifest)
    return restored
