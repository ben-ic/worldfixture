"""Mail fixes retain exact previous bytes outside their reviewed source fields."""
from __future__ import annotations

import copy
import io
import json
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler.compiler import canonical_json, sha256

from tests.parity.finance_migration import finance_record, reverse_finance_migration, write_pre_finance_sources
from tests.parity.mail_migration import (
    MAIL_FILES,
    MAIL_MIGRATION,
    ROOT,
    assert_mail_semantics,
    digest,
    expected_arrivals,
    expected_google,
    mail_source_evidence,
    reverse_mail_migration,
)
from tests.parity.operator_migration import operator_record
from tests.parity.p4_migration import build_historical_finance_stage, bundle_historical_finance_stage
from tests.parity.test_coupling_baseline import BASELINE, CALENDAR_MIGRATION, read_files


class MailMigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.built = {}
        for record in MAIL_MIGRATION['worlds']:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                build_historical_finance_stage(ROOT / record['source'], output)
                cls.built[(record['id'], record['version'])] = reverse_finance_migration(read_files(output))

    def test_exact_scope_and_every_original_byte(self) -> None:
        self.assertEqual(MAIL_FILES, set(MAIL_MIGRATION['allowed_artifact_files']))
        for record in MAIL_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']):
                self.assertTrue(record['reason'])
                self.assertEqual(MAIL_FILES, set(record['files']))
                old = operator_record(record['id'], record['version'])
                self.assertEqual(old['to_source_sha256'], record['from_source_sha256'])
                self.assertEqual(old['to_artifact_sha256'], record['from_artifact_sha256'])
                files = self.built[(record['id'], record['version'])]
                assert_mail_semantics(self, files)
                restored = reverse_mail_migration(files)
                baseline = next(row for row in BASELINE['worlds'] if (row['id'], row['version']) == (record['id'], record['version']))
                calendar = next(row for row in CALENDAR_MIGRATION['worlds'] if (row['id'], row['version']) == (record['id'], record['version']))
                expected = {**baseline['files'], **{name: change['to'] for name, change in calendar['files'].items()},
                            **{name: change['to'] for name, change in old['files'].items()}}
                self.assertEqual(expected, {name: digest(data) for name, data in restored.items()})
                self.assertEqual(set(expected), set(files))
                changed = {name for name in files if files[name] != restored[name]}
                self.assertEqual(MAIL_FILES, changed)
                for name, change in record['files'].items():
                    self.assertEqual(change['from'], digest(restored[name]), name)
                    self.assertEqual(change['to'], digest(files[name]), name)

    def test_source_fragment_removal_proves_original_bytes(self) -> None:
        for record in MAIL_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']):
                evidence = mail_source_evidence(record)
                before = evidence['before_bytes']
                after = evidence['after_bytes']
                self.assertEqual({record['added_source_file']}, set(after) - set(before))
                self.assertEqual({Path(record['source']).name}, {name for name in before if before[name] != after[name]})
                self.assertEqual(record['source_files']['from'], {name: digest(data) for name, data in before.items()})

    def test_transport_reversal_preserves_all_member_metadata(self) -> None:
        for record in MAIL_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'world.tar'
                result = bundle_historical_finance_stage(ROOT / record['source'], path)
                data = path.read_bytes()
                current = finance_record(record['id'], record['version'])['bundle']['to']
                self.assertEqual(current, {'bundle_sha256': sha256(data), 'bundle_size': len(data), 'content_sha256': result['content_sha256']})
                self.assertEqual(current['bundle_sha256'], result['artifact_sha256'])
                self.assertEqual(current['bundle_size'], result['artifact_size'])
                with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
                    members = archive.getmembers()
                    self.assertTrue(all(member.isfile() for member in members))
                    files = {member.name: archive.extractfile(member).read() for member in members}
                self.assertEqual(len(members), len(files))
                files = reverse_finance_migration(files)
                self.assertEqual(self.built[(record['id'], record['version'])], files)
                restored = reverse_mail_migration(files)
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                    for member in members:
                        content = restored[member.name]
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
                previous = record['bundle']['from']
                self.assertEqual(operator_record(record['id'], record['version'])['bundle']['to'], previous)
                self.assertEqual(previous['bundle_sha256'], sha256(output.getvalue()))
                self.assertEqual(previous['bundle_size'], len(output.getvalue()))
                self.assertEqual(previous['content_sha256'], json.loads(restored['manifest.json'])['artifact_sha256'])

    def test_missing_foreign_or_changed_content_cannot_pass(self) -> None:
        record = MAIL_MIGRATION['worlds'][0]
        original = self.built[(record['id'], record['version'])]
        for mutation in ('missing-message', 'foreign-owner', 'provider-id', 'body', 'mailbox', 'label', 'credential', 'drive-content', 'drive-owner', 'linear-task', 'linear-project', 'smtp-arrival', 'seed-version'):
            with self.subTest(mutation=mutation):
                files = dict(original)
                google = json.loads(files['projections/google.json'])
                overlay = json.loads(files['projections/emulator-overlay.json'])
                if mutation == 'missing-message':
                    google['messages'].pop()
                elif mutation == 'foreign-owner':
                    google['messages'][0]['worldfixture_owner_id'] = 'foreign-owner'
                elif mutation == 'provider-id':
                    google['messages'][0]['id'] = google['messages'][0]['worldfixture_message_id']
                elif mutation == 'body':
                    google['messages'][0]['body_text'] = 'Changed message body'
                elif mutation == 'mailbox':
                    google['users'].pop()
                elif mutation == 'label':
                    google['labels'].pop()
                elif mutation == 'credential':
                    overlay['tokens'].pop(next(key for key in overlay['tokens'] if key.startswith('google_token_')))
                elif mutation == 'drive-content':
                    google['drive_items'][0]['data'] = 'Changed document content'
                elif mutation == 'drive-owner':
                    google['drive_items'][0]['user_email'] = 'foreign@example.test'
                elif mutation == 'linear-task':
                    overlay['linear']['issues'][0]['worldfixture_task_id'] = 'foreign-task'
                elif mutation == 'linear-project':
                    overlay['linear']['issues'][0]['worldfixture_project_id'] = 'foreign-project'
                elif mutation == 'smtp-arrival':
                    world = json.loads(files['world.json'])
                    overlay['worldfixture']['arrivals'] = expected_arrivals(world, legacy=True)
                else:
                    overlay['google']['worldfixture_seed_version'] = 2
                files['projections/google.json'] = canonical_json(google)
                files['projections/emulator-overlay.json'] = canonical_json(overlay)
                with self.assertRaises(AssertionError):
                    assert_mail_semantics(self, files)

    def test_new_source_mail_and_gmail_arrivals_change_expectations(self) -> None:
        record = MAIL_MIGRATION['worlds'][0]
        world = json.loads(self.built[(record['id'], record['version'])]['world.json'])
        baseline = expected_google(world)
        message = copy.deepcopy(world['communication']['resolved_mail'][0])
        message['id'] = 'new-source-message'
        message['to_ids'] = [world['communication']['mailboxes'][0]['owner_id']]
        message['labels'] = ['INBOX']
        world['communication']['resolved_mail'].append(message)
        current = expected_google(world)
        self.assertEqual(len(baseline['messages']) + 1, len(current['messages']))
        self.assertEqual(1, sum(row['worldfixture_message_id'] == message['id'] for row in current['messages']))
        self.assertEqual([], expected_arrivals(world), 'Shipped SMTP arrivals must not enter the Gmail seed')
        event = next(row for row in world['timeline'] if row['kind'] == 'incoming-email')
        event['payload']['via'] = 'gmail'
        arrivals = expected_arrivals(world)
        self.assertEqual([event['id']], [row['message']['id'] for row in arrivals])
        self.assertEqual(event['payload']['to_id'], arrivals[0]['worldfixture_owner_id'])
        self.assertEqual(f"google_token_{event['payload']['to_id']}", arrivals[0]['token_ref'])

    def test_reversal_cannot_hide_unrelated_calendar_or_provider_changes(self) -> None:
        record = MAIL_MIGRATION['worlds'][0]
        files = dict(self.built[(record['id'], record['version'])])
        google = json.loads(files['projections/google.json'])
        google['calendar_events'][0]['description'] = 'Unrelated event drift'
        files['projections/google.json'] = canonical_json(google)
        overlay = json.loads(files['projections/emulator-overlay.json'])
        overlay['aws']['iam']['roles'][0]['description'] = 'Unrelated AWS drift'
        files['projections/emulator-overlay.json'] = canonical_json(overlay)
        restored = reverse_mail_migration(files)
        for name in ('projections/google.json', 'projections/emulator-overlay.json'):
            self.assertNotEqual(record['files'][name]['from'], digest(restored[name]))

    def test_new_record_hashes_cannot_authorize_original_source_byte_drift(self) -> None:
        record = copy.deepcopy(MAIL_MIGRATION['worlds'][0])
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            directory = target / Path(record['source']).parent
            shutil.copytree(ROOT / Path(record['source']).parent, directory)
            write_pre_finance_sources(finance_record(record['id'], record['version']), target)
            name = Path(record['source']).name
            path = directory / name
            path.write_bytes(path.read_bytes() + b'\n')
            record['source_files']['to'][name] = digest(path.read_bytes())
            record['to_source_sha256'] = sha256(canonical_json(record['source_files']['to']))
            with self.assertRaisesRegex(AssertionError, 'Original source bytes not reproduced'):
                mail_source_evidence(record, target)


if __name__ == '__main__':
    unittest.main()
