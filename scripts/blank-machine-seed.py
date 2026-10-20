"""Sème une mission dans une base de Mission Engine.

Passe par le dépôt du moteur plutôt que par des `INSERT` écrits à la main :
c'est lui qui connaît son schéma, et du SQL recopié ici deviendrait faux à la
première migration — en silence, puisque le scénario vérifierait alors une
mission qu'il aurait lui-même mal écrite.
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
            "external_key": "scenario-machine-vide",
            "title": "Mission a retrouver",
            "workspace": "/tmp/workspace",
            "tasks": [
                {
                    "key": "une",
                    "profile": "codex",
                    "instruction": "Travaille",
                    "depends_on": [],
                }
            ],
        },
        "scenario-key",
    )


if __name__ == "__main__":
    main()
