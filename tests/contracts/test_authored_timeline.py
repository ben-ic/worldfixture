"""Every authored runnable world has an arc; derived section checks need not."""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from functools import partial
from pathlib import Path

from worldfixture_compiler.compiler import WorldError, build_world, compile_world, load_world, validate_world
from worldfixture_compiler.sections import schema_validator, validate_sections

from tests.contracts.test_compiler_core import MINIMAL_WORLD

ROOT = Path(__file__).resolve().parents[2]
MISSING = object()


class AuthoredTimelineTest(unittest.TestCase):
    def test_missing_empty_and_non_array_timelines_fail_both_contracts(self):
        validator = schema_validator('world-definition.v1.schema.json')
        for profile in (None, 'business.operations/v1'):
            for value in (MISSING, [], None, {}, '', 0):
                with self.subTest(profile=profile, timeline=value):
                    world = copy.deepcopy(MINIMAL_WORLD)
                    if profile:
                        world['profile'] = profile
                    if value is MISSING:
                        world.pop('timeline')
                    else:
                        world['timeline'] = value
                    self.assertFalse(validator.is_valid(world))
                    for operation in (validate_world, compile_world):
                        with self.assertRaisesRegex(WorldError, r'product.marketplace-users:v1.*timeline.*add at least one scheduled arrival'):
                            operation(world)

    def test_fragment_validation_precedes_sorting_and_never_invents_an_arrival(self):
        for value in (MISSING, [], None, {}, [None], [False], [{'id': 'arrival.bad', 'after_seconds': []}],
                      [{'id': [], 'after_seconds': 1}], [{'id': 'arrival.bad', 'after_seconds': True}],
                      [{'id': 'arrival.bad', 'kind': [], 'payload': {}, 'after_seconds': 1}],
                      [{'id': 'arrival.bad', 'kind': 'application-event', 'payload': None, 'after_seconds': 1}]):
            with self.subTest(timeline=value), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                envelope = copy.deepcopy(MINIMAL_WORLD)
                envelope.pop('api_version')
                envelope.pop('timeline')
                contributes = {'records': []}
                if value is not MISSING:
                    contributes['timeline'] = value
                source = {'api_version': 'worldfixture.world-manifest/v1', 'world': envelope, 'fragments': ['part.json']}
                (root / 'world.json').write_text(json.dumps(source))
                (root / 'part.json').write_text(json.dumps({'api_version': 'worldfixture.world-fragment/v1', 'id': 'part.one', 'contributes': contributes}))
                for operation in (partial(load_world, root / 'world.json'), partial(build_world, root / 'world.json', root / 'artifact')):
                    with self.assertRaisesRegex(WorldError, 'product.marketplace-users:v1.*timeline'):
                        operation()
                self.assertFalse((root / 'artifact').exists())

    def test_nonempty_merged_arc_can_include_an_empty_fragment_and_zero_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            world = copy.deepcopy(MINIMAL_WORLD)
            world.pop('api_version')
            first = world.pop('timeline')[0]
            first['after_seconds'] = 0
            later = {**copy.deepcopy(first), 'id': 'arrival.later', 'after_seconds': 604800}
            source = {'api_version': 'worldfixture.world-manifest/v1', 'world': world, 'fragments': ['empty.json', 'later.json', 'first.json']}
            (root / 'world.json').write_text(json.dumps(source))
            for name, events in [('empty', []), ('later', [later]), ('first', [first])]:
                (root / f'{name}.json').write_text(json.dumps({'api_version': 'worldfixture.world-fragment/v1', 'id': f'part.{name}', 'contributes': {'timeline': events}}))
            resolved = load_world(root / 'world.json')[0]
            self.assertEqual([first, later], resolved['timeline'])
            self.assertTrue(schema_validator('world-definition.v1.schema.json').is_valid(resolved))
            self.assertEqual(resolved['timeline'], compile_world(resolved)['timeline'])

    def test_duplicate_ids_and_invalid_offsets_name_the_world_and_arrival(self):
        for offset in (-1, True, 0.5, '30'):
            world = copy.deepcopy(MINIMAL_WORLD)
            world['timeline'][0]['after_seconds'] = offset
            with self.assertRaisesRegex(WorldError, 'product.marketplace-users:v1.*invalid timeline offset: arrival-population-review'):
                validate_world(world)
        world = copy.deepcopy(MINIMAL_WORLD)
        world['timeline'].append(copy.deepcopy(world['timeline'][0]))
        with self.assertRaisesRegex(WorldError, 'product.marketplace-users:v1.*duplicate timeline id: arrival-population-review'):
            validate_world(world)

    def test_starter_arrival_uses_existing_actor_channel_and_source_task(self):
        world = load_world(ROOT / 'examples/minimal-world/world.json')[0]
        schema_validator('world-definition.v1.schema.json').validate(world)
        self.assertEqual(1, len(world['timeline']))
        arrival = world['timeline'][0]
        self.assertEqual(('arrival-export-check', 30, 'chat-message'), (arrival['id'], arrival['after_seconds'], arrival['kind']))
        payload = arrival['payload']
        author = next(person for person in world['people'] if person['id'] == payload['author_id'])
        channel = next(row for row in world['communication']['channels'] if row['id'] == payload['channel_id'])
        self.assertEqual('Tomas Vidal', author['name'])
        self.assertIn(author['id'], channel['member_ids'])
        self.assertEqual('general', channel['name'])
        self.assertEqual('I am checking the export retry for duplicate rows.', payload['text'])
        self.assertTrue(any(task['assignee_id'] == author['id'] for task in world['work']['tasks']))
        compiled = compile_world(world)
        self.assertEqual([arrival], compiled['timeline'])
        self.assertFalse(any(message['text'] == payload['text'] for message in channel['messages']))

    def test_section_validation_remains_valid_for_internal_empty_schedule(self):
        # Domain operation validation checks a hypothetical resulting collection
        # without replaying the authored timeline. It must not invoke the outer
        # runnable-world rule recursively.
        world = copy.deepcopy(MINIMAL_WORLD)
        world['timeline'] = []
        validate_sections(world)
        with self.assertRaisesRegex(WorldError, 'nonempty authored'):
            validate_world(world)

    def test_actor_free_core_fixture_requests_review_of_its_actual_records(self):
        compiled = compile_world(copy.deepcopy(MINIMAL_WORLD))
        self.assertEqual({}, compiled['projections'])
        self.assertNotIn('people', compiled['world'])
        arrival = compiled['timeline'][0]
        self.assertEqual('application-event', arrival['kind'])
        self.assertEqual([record['id'] for record in compiled['world']['records']], arrival['payload']['data']['record_ids'])


if __name__ == '__main__':
    unittest.main()
