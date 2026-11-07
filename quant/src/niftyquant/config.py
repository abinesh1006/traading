"""Paths and settings. Override the data location with NIFTYQUANT_DATA_DIR."""

import os
from pathlib import Path

# quant/src/niftyquant/config.py -> F:\trading
REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_env_file(path: Path) -> None:
    """KEY=VALUE lines from the repo's .env (secrets, Postgres settings). Real env vars win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


_load_env_file(REPO_ROOT / ".env")

DATA_DIR = Path(os.environ.get("NIFTYQUANT_DATA_DIR", REPO_ROOT / "data"))

CURATED_DIR = DATA_DIR / "curated"
REPORTS_DIR = DATA_DIR / "reports"
MANIFEST_PATH = DATA_DIR / "manifest.sqlite"

# Underlyings kept from the F&O bhavcopy. Nifty only for now.
FO_SYMBOLS = ("NIFTY",)
