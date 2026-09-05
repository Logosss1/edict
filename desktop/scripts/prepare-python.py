"""Install the desktop's pure-Python dependency into its packaged resource tree."""
import importlib.metadata
import pathlib
import subprocess
import sys

upstream = pathlib.Path(__file__).resolve().parents[2] / "upstream"
target = upstream / "vendor" / "python"
requirements = upstream / "requirements-desktop.txt"
installed = {item.metadata["Name"].lower(): item.version for item in importlib.metadata.distributions(path=[str(target)])}
expected = dict(line.strip().split("==") for line in requirements.read_text().splitlines() if line.strip() and not line.startswith("#"))
if any(installed.get(name.lower()) != version for name, version in expected.items()):
    subprocess.run([
        sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
        "--no-deps", "--no-compile", "--upgrade", "--target", str(target), "-r", str(requirements),
    ], check=True)
print("Desktop Python dependencies ready")
