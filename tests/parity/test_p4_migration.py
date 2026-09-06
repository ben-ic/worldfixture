"""Actual current P4 artifacts prove content and every original baseline byte."""
from __future__ import annotations

import copy
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler import build_world, bundle_world
from worldfixture_compiler.compiler import canonical_json, sha256

from tests.parity import test_coupling_baseline as original_baseline
from tests.parity.finance_migration import finance_record
from tests.parity.p4_migration import (
    P4_MIGRATION,
    ROOT,
    assert_domain_semantics,
    digest,
    pack_files,
    read_files,
    reverse_json,
    reverse_p4,
    reverse_source,
)


class P4MigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = {}
        for record in P4_MIGRATION['worlds']:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                build_world(ROOT / record['source'], output)
                cls.built[(record['id'], record['version'])] = read_files(output)

    def test_actual_current_artifacts_reverse_to_all_original_file_bytes(self):
        self.assertEqual(len(original_baseline.BASELINE['worlds']), len(P4_MIGRATION['worlds']))
        for record in P4_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']):
                files = self.built[(record['id'], record['version'])]
                manifest = json.loads(files['manifest.json'])
                self.assertEqual(set(manifest['files']) | {'manifest.json'}, set(files))
                self.assertEqual(manifest['files'], {name: digest(data) for name, data in files.items() if name != 'manifest.json'})
                self.assertEqual(manifest['artifact_sha256'], sha256(canonical_json(manifest['files'])))
                restored = reverse_p4(files)
                self.assertEqual(finance_record(record['id'], record['version'])['to_artifact_sha256'], json.loads(restored['manifest.json'])['artifact_sha256'])
                original = next(row for row in original_baseline.BASELINE['worlds'] if (row['id'], row['version']) == (record['id'], record['version']))
                original_baseline.CouplingBaselineTest.assert_file_parity(self, restored, original)

    def test_actual_transport_metadata_and_original_finance_bundle(self):
        for record in P4_MIGRATION['worlds']:
            with self.subTest(world=record['id'], version=record['version']), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'current.tar'
                result = bundle_world(ROOT / record['source'], path)
                with tarfile.open(path) as archive:
                    members = archive.getmembers()
                    self.assertTrue(all(member.isfile() for member in members))
                    files = {member.name: archive.extractfile(member).read() for member in members}
                self.assertEqual(len(files), len(members))
                self.assertEqual(self.built[(record['id'], record['version'])], files)
                self.assertEqual(path.read_bytes(), pack_files(files))
                self.assertEqual(record['to_artifact_sha256'], result['content_sha256'])
                restored = pack_files(reverse_p4(files))
                historical = finance_record(record['id'], record['version'])['bundle']['to']
                self.assertEqual(historical['bundle_sha256'], sha256(restored))
                self.assertEqual(historical['bundle_size'], len(restored))

    def test_source_changes_reverse_exact_bytes_and_reject_whitespace_drift(self):
        for record in P4_MIGRATION['worlds']:
            directory = ROOT / Path(record['source']).parent
            current = {name: (directory / name).read_bytes() for name in record['source_files']['to']}
            restored = reverse_source(record, current)
            self.assertEqual(record['source_files']['from'], {name: digest(data) for name, data in restored.items()})
            current['world.json'] += b'\n'
            with self.assertRaisesRegex(AssertionError, 'source bytes changed'):
                reverse_source(record, current)

    def test_domain_semantics_reject_missing_foreign_changed_and_reordered_records(self):
        record = P4_MIGRATION['worlds'][-1]
        original = self.built[(record['id'], record['version'])]
        for mutation in ('missing', 'foreign', 'changed', 'reordered', 'canonical', 'undeclared-provider'):
            with self.subTest(mutation=mutation):
                files = dict(original)
                domain = json.loads(files['projections/domain.json'])
                orders = domain['collections']['commerce.orders']
                if mutation == 'missing':
                    orders.pop()
                elif mutation == 'foreign':
                    orders.append({**orders[0], 'id': 'foreign-order'})
                elif mutation == 'changed':
                    orders[0]['items'][0]['quantity'] += 1
                elif mutation == 'reordered':
                    orders.reverse()
                elif mutation == 'canonical':
                    world = json.loads(files['world.json'])
                    world['people'][0]['name'] = 'Foreign'
                    files['world.json'] = canonical_json(world)
                else:
                    files['projections/apple.json'] = canonical_json({'users': []})
                files['projections/domain.json'] = canonical_json(domain)
                with self.assertRaises(AssertionError):
                    assert_domain_semantics(files)

    def test_reversal_cannot_hide_unrelated_changes_or_whole_file_replacement(self):
        record = P4_MIGRATION['worlds'][0]
        files = dict(self.built[(record['id'], record['version'])])
        value = json.loads(files['projections/google.json'])
        value['calendar_events'][0]['summary'] = 'Unrelated change'
        files['projections/google.json'] = canonical_json(value)
        with self.assertRaisesRegex(AssertionError, 'artifact bytes changed'):
            reverse_p4(files)
        with self.assertRaisesRegex(AssertionError, 'Whole-file'):
            reverse_json({}, [{'path': [], 'before': {'hidden': 'replacement'}, 'after': {}}])
        record = copy.deepcopy(record)
        edit = next(iter(record['json_edits'].values()))[0]
        edit['after'] = 'foreign'
        name = next(iter(record['json_edits']))
        with self.assertRaises(AssertionError):
            reverse_json(json.loads(self.built[(record['id'], record['version'])][name]), record['json_edits'][name])


if __name__ == '__main__':
    unittest.main()
