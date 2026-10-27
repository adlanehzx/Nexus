# Third-Party Dependencies and Services

NEXUS project code is distributed under `AGPL-3.0-or-later`. Each dependency retains its own
license; `pnpm licenses list --prod` produces the exact inventory of the JavaScript dependency tree
for the installed version, and `uv.lock` files pin Python dependency trees.

## Distributed Dependencies

The JavaScript tree primarily contains MIT, Apache-2.0, ISC, and BSD components, as well as
MPL-2.0, EPL-2.0, LGPL-3.0-or-later, and dual-licensed components. These licenses are not replaced
by the NEXUS license. Published container images and release packages include an SPDX SBOM to
identify each component and its exact version.

The API container includes Sherlock Project `0.16.2` as an isolated Python virtual-environment
executable for public username discovery. Sherlock is maintained at
<https://github.com/sherlock-project/sherlock> and distributed under the MIT license. NEXUS invokes
its unmodified command-line interface with validated arguments; Sherlock remains a separate work and
retains its own copyright and license.

The model-routing package includes FreeLLM `0.5.2`, maintained at
<https://github.com/shihabshahrier/freelm> and distributed under the MIT license. NEXUS uses it only
as an optional free-tier router. Upstream providers—including NVIDIA NIM—retain their own terms,
quotas, privacy policies, and development-versus-production restrictions.

## Separate Optional Services

Browser Use, SearXNG, Grafana, Loki, Tempo, Prometheus, PostgreSQL/pgvector, and MCP servers run as
separate processes or containers. They do not become NEXUS code and remain subject to their respective
licenses, including when a copyleft or AGPL license applies to that service. Their activation is optional
via Docker Compose profiles or configuration flags.

ACP CLIs (Codex, Claude Code, Antigravity, and their adapters) are neither redistributed nor sold by
this repository. Users install them and authenticate with their respective providers under their own
terms of service. NEXUS does not convert an existing personal subscription into any redistribution right.

Prior to any release, the license inventory must be audited, and any unknown or non-commercial license
must block publication.
