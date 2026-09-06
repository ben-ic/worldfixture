"""Google account declarations preserve owner identity, content, and strict labels."""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler.compiler import (
    WorldError,
    build_world,
    canonical_json,
    compile_world,
    load_world,
    validate_world,
)

ROOT = Path(__file__).resolve().parents[2]
NAMES = ['business.saas-company.v2', 'business.saas-company.v3', 'consumer.retail-brand.v1']

def source(name=NAMES[0], explicit=True):
    world, _ = load_world(ROOT / 'worlds' / name / 'world.json')
    if not explicit:
        world['communication'].pop('mailboxes', None)
    return world

def arrival(world, via='gmail', owner=None, labels=None):
    row = next(event for event in world['timeline'] if event['kind'] == 'incoming-email')
    row['payload']['via'] = via
    if owner is not None:
        row['payload']['to_id'] = owner
    if labels is not None:
        row['payload']['labels'] = labels
    return row

def clear_google_content(world):
    removed = {row['id'] for key in ['documents', 'calendars', 'calendar_events'] for row in world['communication'].get(key, [])}
    for key in ['documents', 'calendars', 'calendar_events']:
        world['communication'][key] = []
    def remove_refs(value):
        if isinstance(value, dict):
            refs = value.get('entity_refs')
            if isinstance(refs, dict):
                value['entity_refs'] = {key: target for key, target in refs.items() if target not in removed}
            elif isinstance(refs, list):
                value['entity_refs'] = [target for target in refs if target not in removed]
            for child in value.values():
                remove_refs(child)
        elif isinstance(value, list):
            for child in value:
                remove_refs(child)
    remove_refs(world)
    world['agentic']['grounding'] = [row for row in world['agentic'].get('grounding', []) if row.get('entity_id') not in removed]

class MailboxTest(unittest.TestCase):

    def test_every_shipped_owner_and_source_message_copy_projects(self):
        for name, count, copies in zip(NAMES, [16, 161, 41], [129, 4542, 292], strict=True):
            with self.subTest(world=name):
                world = source(name)
                compiled = compile_world(world)
                google = compiled['projections']['google']
                overlay = compiled['projections']['emulator-overlay']
                self.assertEqual(count, len(google['users']))
                self.assertEqual(copies, len(google['messages']))
                self.assertEqual({person['id'] for person in world['people']}, {user['worldfixture_person_id'] for user in google['users']})
                expected = {(owner, message['id']) for message in compiled['world']['communication']['resolved_mail'] for owner in set(message['to_ids']) | ({message['from_id']} if 'SENT' in message['labels'] else set())}
                self.assertEqual(expected, {(row['worldfixture_owner_id'], row['worldfixture_message_id']) for row in google['messages']})
                self.assertEqual(len(google['messages']), len({row['id'] for row in google['messages']}))
                self.assertEqual({f"google_token_{row['owner_id']}" for row in world['communication']['mailboxes']}, {key for key in overlay['tokens'] if key.startswith('google_token_')})
                self.assertEqual({task['id'] for task in world['work']['tasks']}, {row['worldfixture_task_id'] for row in overlay['linear']['issues']})
                self.assertEqual([], compiled['projections']['emulator-overlay']['worldfixture']['arrivals'])

    def test_existing_calendars_and_events_are_preserved(self):
        for name in NAMES:
            world = source(name)
            google = compile_world(world)['projections']['google']
            self.assertEqual([row['id'] for row in world['communication']['calendars']], [row['id'] for row in google['calendars']])
            self.assertEqual([row['id'] for row in world['communication']['calendar_events']], [row['id'] for row in google['calendar_events']])
            for authored, projected in zip(world['communication']['calendars'], google['calendars'], strict=True):
                self.assertEqual(authored.get('summary') or authored.get('name') or authored.get('title') or authored['id'], projected['summary'])

    def test_explicit_empty_and_subset_select_no_extra_owners_labels_or_tokens(self):
        for selection in [[], [source()['communication']['mailboxes'][0]]]:
            world = source()
            world['communication']['mailboxes'] = selection
            clear_google_content(world)
            compiled = compile_world(world)
            google = compiled['projections']['google']
            owners = {row['owner_id'] for row in selection}
            self.assertEqual(owners, {user['worldfixture_person_id'] for user in google['users']})
            self.assertTrue(all(row['worldfixture_owner_id'] in owners for row in google['messages']))
            self.assertEqual({f'google_token_{owner}' for owner in owners}, {key for key in compiled['projections']['emulator-overlay']['tokens'] if key.startswith('google_token_')})

    def test_future_label_must_exist_for_the_exact_owner(self):
        world = source()
        owner = world['communication']['mailboxes'][0]
        arrival(world, owner=owner['owner_id'], labels=['INBOX', 'Future'])
        with self.assertRaisesRegex(WorldError, 'undeclared Gmail custom labels.*Future'):
            validate_world(world)
        world['communication']['mailboxes'][1]['labels'].append('Future')
        with self.assertRaisesRegex(WorldError, 'undeclared Gmail custom labels.*Future'):
            compile_world(world)
        owner['labels'].append('Future')
        compiled = compile_world(world)
        projected = compiled['projections']['emulator-overlay']['worldfixture']['arrivals'][0]
        self.assertEqual(owner['owner_id'], projected['worldfixture_owner_id'])
        self.assertEqual(f"google_token_{owner['owner_id']}", projected['token_ref'])
        self.assertTrue(any(row['id'] == 'Future' and row['user_email'] == projected['user'] for row in compiled['projections']['google']['labels']))

    def test_label_typo_does_not_create_a_declaration_or_an_artifact(self):
        world = source()
        world['communication']['mail'][0]['labels'].append('Finanec')
        before = copy.deepcopy(world['communication']['mailboxes'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'world.json'
            out = Path(directory) / 'artifact'
            path.write_bytes(canonical_json(world))
            with self.assertRaisesRegex(WorldError, 'undeclared Gmail custom labels.*Finanec'):
                build_world(path, out)
            self.assertFalse(out.exists())
        self.assertEqual(before, world['communication']['mailboxes'])

    def test_gmail_requires_a_mailbox_but_smtp_does_not(self):
        world = source()
        world['communication']['mailboxes'] = []
        clear_google_content(world)
        event = arrival(world)
        with self.assertRaisesRegex(WorldError, 'has no declared mailbox'):
            validate_world(world)
        event['payload']['via'] = 'smtp'
        event['payload']['labels'] = ['SMTPOnly']
        compiled = compile_world(world)
        self.assertEqual([], compiled['projections']['google']['users'])
        self.assertEqual([], compiled['projections']['emulator-overlay']['worldfixture']['arrivals'])
        self.assertEqual(len(world['people']), len(compiled['projections']['mail']['users']))

    def test_generated_invoice_labels_must_also_be_declared(self):
        world = source(NAMES[1])
        world['communication']['mail'] = []
        for row in world['communication']['mailboxes']:
            row['labels'] = []
        validate_world(world)
        with self.assertRaisesRegex(WorldError, 'undeclared Gmail custom labels.*Finance'):
            compile_world(world)

    def test_absent_field_has_separate_legacy_derived_labels(self):
        world = source(explicit=False)
        arrival(world, labels=['LegacyFuture'])
        google = compile_world(world)['projections']['google']
        self.assertEqual(len(world['people']), len(google['users']))
        self.assertTrue(any(row['id'] == 'LegacyFuture' for row in google['labels']))
        self.assertNotIn('mailboxes', world['communication'])

    def test_declarations_reject_unknown_owners_and_invalid_or_system_labels(self):
        invalid = [None, {}, [None], [{'owner_id': 'missing', 'labels': []}], [{'owner_id': 'maya-chen', 'labels': None}], [{'owner_id': 'maya-chen', 'labels': ['']}], [{'owner_id': 'maya-chen', 'labels': [3]}], [{'owner_id': 'maya-chen', 'labels': ['a', 'a']}], [{'owner_id': 'maya-chen', 'labels': ['INBOX']}], [{'owner_id': 'maya-chen', 'labels': []}, {'owner_id': 'maya-chen', 'labels': []}]]
        for rows in invalid:
            with self.subTest(value=rows):
                world = source()
                world['communication']['mailboxes'] = rows
                with self.assertRaises(WorldError):
                    validate_world(world)

    def test_malformed_gmail_labels_always_raise_world_errors(self):
        for labels in [None, {}, [{}], [[]], 3, [3], ['x', 'x']]:
            world = source()
            event = arrival(world, labels=labels)
            event['payload']['labels'] = labels
            with self.subTest(labels=labels), self.assertRaisesRegex(WorldError, f"business.saas-company:v2 timeline {event['id']}.*labels"):
                validate_world(world)

    def test_incoming_email_reference_errors_name_world_event_and_exact_field(self):
        for name in NAMES:
            for field, role in [('from_id', 'sender'), ('to_id', 'recipient')]:
                for via in ['gmail', 'smtp', None]:
                    with self.subTest(world=name, field=field, via=via):
                        world = source(name)
                        event = arrival(world)
                        if via is None:
                            event['payload'].pop('via')
                        else:
                            event['payload']['via'] = via
                        event['payload'][field] = 'missing-person'
                        with self.assertRaises(WorldError) as raised:
                            validate_world(world)
                        context = f"world {world['id']}:{world['version']} timeline {event['id']} payload.{field}"
                        expected = (f'{context} Gmail recipient missing-person has no declared mailbox'
                                    if via == 'gmail' and field == 'to_id' else f'{context} has unknown {role}')
                        self.assertEqual(expected, str(raised.exception))

    def test_malformed_incoming_email_references_fail_before_artifact_writes(self):
        for field in ['from_id', 'to_id']:
            for value in ['missing-field', None, {}, [], 42]:
                with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as directory:
                    world = source()
                    event = arrival(world)
                    if value == 'missing-field':
                        event['payload'].pop(field)
                    else:
                        event['payload'][field] = value
                    path = Path(directory) / 'world.json'
                    output = Path(directory) / 'artifact'
                    path.write_bytes(canonical_json(world))
                    with self.assertRaises(WorldError) as raised:
                        build_world(path, output)
                    self.assertIn(f"world {world['id']}:{world['version']} timeline {event['id']} payload.{field}", str(raised.exception))
                    self.assertFalse(output.exists())

    def test_shared_google_token_never_names_an_excluded_primary(self):
        world = source()
        primary = next(row['id'] for row in world['people'] if row.get('primary'))
        for rows in [[], [row for row in world['communication']['mailboxes'] if row['owner_id'] != primary]]:
            world['communication']['mailboxes'] = rows
            clear_google_content(world)
            overlay = compile_world(world)['projections']['emulator-overlay']
            self.assertNotIn('demo_token', overlay['tokens'])
            self.assertNotIn('google_token_' + primary, overlay['tokens'])
            self.assertEqual(1, overlay['google']['worldfixture_seed_version'])
            self.assertEqual(1, overlay['linear']['worldfixture_seed_version'])

    def test_explicit_shipped_source_double_build_is_deterministic(self):
        for name in NAMES:
            with self.subTest(world=name), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                path = directory / 'world.json'
                path.write_bytes(canonical_json(source(name)))
                first = build_world(path, directory / 'first')
                second = build_world(path, directory / 'second')
                self.assertEqual(first, second)
                for file in (directory / 'first').rglob('*'):
                    if file.is_file():
                        self.assertEqual(file.read_bytes(), (directory / 'second' / file.relative_to(directory / 'first')).read_bytes())

    def test_excluded_calendar_event_and_document_owners_are_not_silently_filtered(self):
        for field in ['calendars', 'calendar_events', 'documents']:
            world = source()
            kept = copy.deepcopy(world['communication'][field])
            clear_google_content(world)
            world['communication'][field] = kept
            world['communication']['mailboxes'] = []
            with self.subTest(field=field), self.assertRaisesRegex(WorldError, f'communication\\.{field} .*has no declared Google mailbox/account'):
                compile_world(world)

    def test_drive_projection_keeps_source_identity_name_mime_content_and_owner(self):
        for name in NAMES:
            world = source(name)
            google = compile_world(world)['projections']['google']
            people = {row['id']: row for row in world['people']}
            self.assertEqual(len(world['communication']['documents']), len(google['drive_items']))
            for source_doc, item in zip(world['communication']['documents'], google['drive_items'], strict=True):
                for field, value in source_doc.items():
                    self.assertEqual(value, item[field])
                self.assertEqual(source_doc['owner_id'], item['worldfixture_owner_id'])
                self.assertEqual(source_doc['id'], item['worldfixture_document_id'])
                self.assertEqual(people[source_doc['owner_id']]['email'], item['user_email'])
                self.assertEqual(source_doc['content'], item['data'])

    def test_ids_are_deterministic_and_owner_specific(self):
        world = source()
        first = compile_world(world)['projections']['google']
        second = compile_world(copy.deepcopy(world))['projections']['google']
        self.assertEqual(first, second)
        groups = {}
        for row in first['messages']:
            groups.setdefault(row['worldfixture_message_id'], []).append(row)
        pair = next(rows for rows in groups.values() if len(rows) > 1)
        self.assertNotEqual(pair[0]['id'], pair[1]['id'])

    def test_retail_generator_keeps_frozen_mailbox_declarations(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'retail'
            shutil.copytree(ROOT / 'worlds/consumer.retail-brand.v1', target, ignore=shutil.ignore_patterns('__pycache__'))
            before = {str(path.relative_to(target)): json.loads(path.read_text()) for path in target.rglob('*.json')}
            frozen = (target / 'packs/google-mailboxes.json').read_bytes()
            subprocess.run([sys.executable, str(target / 'generate.py')], check=True, capture_output=True)
            after = {str(path.relative_to(target)): json.loads(path.read_text()) for path in target.rglob('*.json')}
            self.assertEqual(before, after)
            self.assertEqual(frozen, (target / 'packs/google-mailboxes.json').read_bytes())
            first = {str(path.relative_to(target)): path.read_bytes() for path in target.rglob('*.json')}
            subprocess.run([sys.executable, str(target / 'generate.py')], check=True, capture_output=True)
            self.assertEqual(first, {str(path.relative_to(target)): path.read_bytes() for path in target.rglob('*.json')})
if __name__ == '__main__':
    unittest.main()
