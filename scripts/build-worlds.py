"""Build release worlds with the compiler's declared Python dependencies."""

import os
import subprocess
import sys
import venv
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    environment = root / ".worldfixture" / "build-venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        print("Preparing the local compiler environment...", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)

    # The same file compiler installation and CI install from, so a package
    # build cannot resolve a different version than either of them. Keep these
    # packages out of the user's system Python, including Homebrew Python.
    #
    # Read as a requirements file rather than parsed out of `pyproject.toml`:
    # the pin moved into `requirements.txt` and pyproject now declares it
    # `dynamic`, so `project.dependencies` is no longer there to read.
    subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check",
         "-r", str(root / "requirements.txt")],
        cwd=root, check=True,
    )
    for world in (
        "business.saas-company.v2",
        "business.saas-company.v3",
        "consumer.retail-brand.v1",
    ):
        subprocess.run(
            [str(python), "-m", "worldfixture_compiler", "build",
             f"worlds/{world}/world.json", "--output", f"dist/{world}"],
            cwd=root, env={**os.environ, "PYTHONPATH": str(root / "compiler")},
            check=True,
        )


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
