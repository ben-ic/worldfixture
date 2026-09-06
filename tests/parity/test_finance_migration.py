"""The finance migration preserves all prior bytes and has source-based checks."""
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

from tests.parity.finance_migration import (
    ALLOWED_ROOTS,
    FINANCE_MIGRATION,
    ROOT,
    assert_finance_semantics,
    digest,
    expanded_edits,
    expected_finance,
    finance_source_evidence,
    merge_source,
    reverse_finance_migration,
)
from tests.parity.mail_migration import mail_record
from tests.parity.p4_migration import build_historical_finance_stage, bundle_historical_finance_stage


def read_files(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob('*') if path.is_file()}


class FinanceMigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = {}
        for record in FINANCE_MIGRATION['worlds']:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                build_historical_finance_stage(ROOT / record['source'], output)
                cls.built[(record['id'], record['version'])] = read_files(output)

    def test_exact_scope_source_semantics_and_previous_bytes(self):
        for record in FINANCE_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']):
                self.assertTrue(record['reason'])
                previous = mail_record(record['id'], record['version'])
                self.assertEqual(previous['to_source_sha256'], record['from_source_sha256'])
                self.assertEqual(previous['to_artifact_sha256'], record['from_artifact_sha256'])
                self.assertEqual({'packs/finance-settlements.json'}, set(record['added_source_files']))
                self.assertEqual(set(record['files']) - {'manifest.json'}, set(record['json_edits']))
                for name, edits in record['json_edits'].items():
                    self.assertIn(name, ALLOWED_ROOTS)
                    for edit in expanded_edits(edits):
                        self.assertTrue(edit['path'], 'No whole-file replacement')
                files = self.built[(record['id'], record['version'])]
                assert_finance_semantics(self, files)
                restored = reverse_finance_migration(files)
                self.assertEqual(set(files), set(restored))
                self.assertEqual(record['from_artifact_sha256'], json.loads(restored['manifest.json'])['artifact_sha256'])
                self.assertEqual(set(record['files']), {name for name in files if files[name] != restored[name]})
                for name, change in record['files'].items():
                    self.assertEqual(change['from'], digest(restored[name]), name)
                    self.assertEqual(change['to'], digest(files[name]), name)

    def test_transport_preserves_member_order_and_all_other_metadata(self):
        for record in FINANCE_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'world.tar'
                result = bundle_historical_finance_stage(ROOT / record['source'], path)
                data = path.read_bytes()
                self.assertEqual(record['bundle']['to'], {'bundle_sha256': sha256(data), 'bundle_size': len(data), 'content_sha256': result['content_sha256']})
                with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
                    members = archive.getmembers()
                    self.assertTrue(all(member.isfile() for member in members))
                    files = {member.name: archive.extractfile(member).read() for member in members}
                self.assertEqual(len(members), len(files))
                restored = reverse_finance_migration(files)
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                    for member in members:
                        content = restored[member.name]
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
                self.assertEqual(record['bundle']['from'], mail_record(record['id'], record['version'])['bundle']['to'])
                self.assertEqual(record['bundle']['from']['bundle_sha256'], sha256(output.getvalue()))
                self.assertEqual(record['bundle']['from']['bundle_size'], len(output.getvalue()))

    def test_semantics_reject_missing_foreign_and_changed_financial_content(self):
        record = FINANCE_MIGRATION['worlds'][-1]
        original = self.built[(record['id'], record['version'])]
        for mutation in ('invoice', 'payment', 'refund', 'ledger', 'currency', 'amount', 'date', 'link', 'one-time-subscription', 'source'):
            with self.subTest(mutation=mutation):
                files = dict(original)
                world = json.loads(files['world.json'])
                stripe = json.loads(files['projections/stripe.json'])
                if mutation in {'invoice', 'payment', 'refund'}:
                    collection = stripe['invoices'] if mutation == 'invoice' else stripe['transactions'][mutation + 's']
                    collection.pop()
                elif mutation == 'ledger':
                    world['finance']['resolved']['ledger_entries'][0]['credit_cents'] += 1
                elif mutation == 'one-time-subscription':
                    stripe['subscriptions'].append({'id': 'foreign-one-time', 'metadata': {'worldfixture_customer_id': 'shop-wes-agyeman'}})
                elif mutation == 'source':
                    world['finance']['payments'].pop()
                else:
                    payment = stripe['transactions']['payments'][0]
                    payment[{'currency': 'currency', 'amount': 'amount', 'date': 'created', 'link': 'invoice'}[mutation]] = 'foreign'
                files['world.json'] = canonical_json(world)
                files['projections/stripe.json'] = canonical_json(stripe)
                # Recompute inventory hashes, so these failures must arise from
                # the source/relationship checks before the recorded digest.
                manifest = json.loads(files['manifest.json'])
                manifest['files'] = {name: digest(data) for name, data in files.items() if name != 'manifest.json'}
                manifest['artifact_sha256'] = sha256(canonical_json(manifest['files']))
                files['manifest.json'] = canonical_json(manifest)
                with self.assertRaises(AssertionError):
                    assert_finance_semantics(self, files)

    def test_authored_override_changes_expected_payment_without_duplicates(self):
        record = FINANCE_MIGRATION['worlds'][0]
        source = merge_source(finance_source_evidence(record)['after_bytes'])
        authored = source['finance']['payments'][0]
        expected = expected_finance(source)
        rows = [row for row in expected['payments'] if row.get('invoice_id') == authored['invoice_id']]
        self.assertEqual([authored['id']], [row['id'] for row in rows])
        authored['paid_on'] = '2026-08-19'
        authored['id'] = 'new-authored-payment'
        changed = expected_finance(source)
        rows = [row for row in changed['payments'] if row.get('invoice_id') == authored['invoice_id']]
        self.assertEqual([('new-authored-payment', '2026-08-19')], [(row['id'], row['paid_on']) for row in rows])
        self.assertNotEqual(expected, changed)

    def test_reversal_rejects_changed_reviewed_values(self):
        record = FINANCE_MIGRATION['worlds'][0]
        files = dict(self.built[(record['id'], record['version'])])
        stripe = json.loads(files['projections/stripe.json'])
        stripe['transactions']['payments'][0]['amount'] += 1
        files['projections/stripe.json'] = canonical_json(stripe)
        with self.assertRaisesRegex(AssertionError, 'Changed value drifted'):
            reverse_finance_migration(files)

    def test_reversal_does_not_mask_unrelated_calendar_or_aws_edits(self):
        record = FINANCE_MIGRATION['worlds'][0]
        files = dict(self.built[(record['id'], record['version'])])
        overlay = json.loads(files['projections/emulator-overlay.json'])
        overlay['google']['calendar_events'][0]['description'] = 'Unrelated calendar change'
        overlay['aws']['iam']['roles'][0]['description'] = 'Unrelated role change'
        files['projections/emulator-overlay.json'] = canonical_json(overlay)
        restored = reverse_finance_migration(files)
        self.assertNotEqual(record['files']['projections/emulator-overlay.json']['from'], digest(restored['projections/emulator-overlay.json']))
        value = json.loads(restored['projections/emulator-overlay.json'])
        self.assertEqual('Unrelated calendar change', value['google']['calendar_events'][0]['description'])
        self.assertEqual('Unrelated role change', value['aws']['iam']['roles'][0]['description'])

    def test_accepting_new_hash_cannot_hide_original_source_whitespace_drift(self):
        record = copy.deepcopy(FINANCE_MIGRATION['worlds'][0])
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            directory = target / Path(record['source']).parent
            shutil.copytree(ROOT / Path(record['source']).parent, directory)
            name = 'world.json'
            path = directory / name
            path.write_bytes(path.read_bytes() + b'\n')
            record['source_files']['to'][name] = digest(path.read_bytes())
            record['to_source_sha256'] = sha256(canonical_json(record['source_files']['to']))
            with self.assertRaisesRegex(AssertionError, 'Current P4 source bytes changed|Original source bytes not reproduced'):
                finance_source_evidence(record, target)


if __name__ == '__main__':
    unittest.main()
