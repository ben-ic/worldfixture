"""Build release worlds with the compiler's declared Python dependencies."""

import os
import subprocess
import sys
import tomllib
import venv
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    environment = root / ".worldfixture" / "build-venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        print("Preparing the local compiler environment...", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)

    # Use the same requirements as compiler installation and CI. Keep these
    # packages out of the user's system Python, including Homebrew Python.
    project = tomllib.loads((root / "pyproject.toml").read_text())
    subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check",
         *project["project"]["dependencies"]],
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
