"""Seeds a mission in a Mission Engine database.

Uses the engine repository rather than handcrafted INSERT statements:
the repository maintains schema knowledge, preventing divergence during migrations.
"""

import sys

sys.path.insert(0, "src")

from nexus_engine.database import Database  # noqa: E402
from nexus_engine.repository import MissionRepository  # noqa: E402


def main() -> None:
    repository = MissionRepository(Database(sys.argv[1]))
    repository.register_profile("codex", "profile-codex")
    repository.submit(
        {
            "external_key": "scenario-blank-machine",
            "title": "Mission to recover",
            "workspace": "/tmp/workspace",
            "tasks": [
                {
                    "key": "one",
                    "profile": "codex",
                    "instruction": "Work",
                    "depends_on": [],
                }
            ],
        },
        "scenario-key",
    )


if __name__ == "__main__":
    main()
