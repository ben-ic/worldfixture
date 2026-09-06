from __future__ import annotations

import copy
import unittest
from pathlib import Path

from worldfixture_compiler import load_world, validate_world
from worldfixture_compiler.compiler import compile_world

ROOT = Path(__file__).resolve().parents[2]


def replace_reference(value, previous, current):
    if isinstance(value, dict):
        return {key: replace_reference(item, previous, current) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_reference(item, previous, current) for item in value]
    return current if value == previous else value


class PersonNameProjectionTest(unittest.TestCase):
    def test_mononyms_and_unusual_person_ids_compile_without_an_invented_surname(self):
        for source in sorted((ROOT / "worlds").glob("*/world.json")):
            with self.subTest(source=source.parent.name):
                world = load_world(source)[0]
                primary = next(person for person in world["people"] if person.get("primary"))
                previous_id = primary["id"]
                primary_email = primary["email"]
                github_login = primary.get("github_login")
                world = replace_reference(world, previous_id, "person-47.uncommon")
                primary = next(person for person in world["people"] if person["id"] == "person-47.uncommon")
                primary["name"] = "Tavi"
                # A GitHub login is an independent provider identity. Its
                # character rules differ from the world's person ID rules.
                if github_login is not None:
                    primary["github_login"] = github_login
                # Resend projects customer contacts, rather than primary staff.
                contact_id = world["finance"]["customers"][0]["contact_id"]
                contact = next(person for person in world["people"] if person["id"] == contact_id)
                contact["name"] = "Mira"
                world["software"]["oauth_clients"] = {"apple": [{
                    "client_id": "mononym-test", "name": "Mononym test",
                    "redirect_uris": ["http://application.test/callback"],
                }]}
                before = copy.deepcopy(world)
                validate_world(world)
                compiled = compile_world(world)
                self.assertEqual(world, before, "Compilation must not change source references")
                for provider in ("microsoft", "apple", "clerk", "okta"):
                    row = next(row for row in compiled["projections"][provider]["users"]
                               if row["worldfixture_person_id"] == "person-47.uncommon")
                    self.assertEqual(row.get("given_name", row.get("first_name")), "Tavi")
                    self.assertEqual(row.get("family_name", row.get("last_name")), "")
                row = next(row for row in compiled["projections"]["resend"]["contacts"]
                           if row["worldfixture_person_id"] == contact_id)
                self.assertEqual((row["first_name"], row["last_name"]), ("Mira", ""))
                self.assertEqual(next(person for person in compiled["world"]["people"]
                                      if person["id"] == "person-47.uncommon")["email"], primary_email)
                self.assertEqual(compiled["world"]["communication"]["channels"], world["communication"]["channels"])
                self.assertEqual(compiled["timeline"], world["timeline"])
                self.assertEqual(compiled["world"]["software"]["operator_ids"], world["software"]["operator_ids"])


if __name__ == "__main__":
    unittest.main()
