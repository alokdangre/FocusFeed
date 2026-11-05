"""Copy only runtime modules into SAM's artifact directory, never .env or admin tools."""

import argparse
import shutil
from pathlib import Path

RUNTIME_FILES = ("__init__.py", "handler.py", "auth.py", "accounts.py", "user_cache.py", "controls.py", "jobs.py",
                 "dodo.py", "billing.py", "billing_worker.py",
                 "classifier.py", "channel_classifier.py", "models.py", "taxonomy.py", "video_cache.py")


def copy_runtime(destination: Path, source: Path | None = None):
    source = source or Path(__file__).resolve().parent
    destination.mkdir(parents=True, exist_ok=True)
    for name in RUNTIME_FILES:
        shutil.copyfile(source / name, destination / name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    copy_runtime(parser.parse_args().destination)
