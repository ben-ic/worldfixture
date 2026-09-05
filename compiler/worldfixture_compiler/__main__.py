from __future__ import annotations

import argparse
import tempfile
from datetime import datetime
from pathlib import Path

from .compiler import WorldError, build_rebased_world, build_world, bundle_world, load_world


def main() -> int:
    parser = argparse.ArgumentParser(prog="worldfixture-compiler")
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="validate one source world")
    validate.add_argument("source", type=Path)

    build = commands.add_parser("build", help="compile one source world")
    build.add_argument("source", type=Path)
    build.add_argument("--output", required=True, type=Path)

    bundle = commands.add_parser("bundle", help="build one deterministic transport artifact")
    bundle.add_argument("source", type=Path)
    bundle.add_argument("--output", required=True, type=Path)

    rebase = commands.add_parser("rebase", help="build one world at a session time")
    rebase.add_argument("source", type=Path)
    rebase.add_argument("--target", required=True, type=datetime.fromisoformat)
    rebase.add_argument("--output", required=True, type=Path)

    args = parser.parse_args()
    try:
        if args.command == "validate":
            # Validate by COMPILING, into a directory that is then thrown away.
            #
            # `validate` used to run the profile's validator alone, and the
            # validator and the compiler had drifted: the validator read a domain
            # with `.get(...)` where the compiler indexed it, and required fields
            # the compiler needs went unchecked. So a world could pass `validate`
            # cleanly and then fail `build` -- sometimes on a bare `KeyError`,
            # which is not caught below and reached the author as a traceback.
            # Somebody writing a small world hit that seven times in a row.
            #
            # The only honest way to answer "will this build?" is to build it.
            # Nothing else can drift, and the cost is one compile of a world the
            # author is about to compile anyway.
            world, _provenance = load_world(args.source)
            with tempfile.TemporaryDirectory() as directory:
                build_world(args.source, Path(directory) / "artifact")
            print(f"valid: {world['id']}@{world['version']}")
        elif args.command == "build":
            manifest = build_world(args.source, args.output)
            print(
                f"built: {manifest['world_id']}@{manifest['world_version']} "
                f"sha256:{manifest['artifact_sha256']}"
            )
        elif args.command == "rebase":
            manifest = build_rebased_world(args.source, args.target, args.output)
            print(
                f"rebased: {manifest['world_id']}@{manifest['world_version']} "
                f"sha256:{manifest['artifact_sha256']}"
            )
        else:
            artifact = bundle_world(args.source, args.output)
            print(
                f"bundled: {artifact['world_id']}@{artifact['world_version']} "
                f"sha256:{artifact['artifact_sha256']} size:{artifact['artifact_size']}"
            )
    except StopIteration:
        # A `next(...)` in the compiler with nothing to find. Bare, so it carries
        # no message at all; without this the author sees the single word
        # "StopIteration" and has nothing to act on.
        parser.error(
            "the profile's compiler looked for a record this world does not have, and did not say which. "
            "That is a WorldFixture bug: please report the world source that produced it."
        )
    except KeyError as error:
        # A domain the profile's compiler indexes and this world does not have.
        # `validate` refuses these first, so reaching here means the profile's
        # requirements and its compiler have drifted apart -- which is a fault in
        # WorldFixture, and has to say so rather than print a traceback at the
        # person writing the world.
        parser.error(
            f"this world has no {error} and the profile's compiler requires it. "
            "That is a WorldFixture bug: `validate` should have refused it first."
        )
    except (OSError, ValueError, WorldError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
