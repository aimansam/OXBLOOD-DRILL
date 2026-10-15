# Monorepo Structure

The repository keeps its existing `divide-*` runtime names and API paths. The
first monorepo phase only separates deployable applications from shared
infrastructure and scenario content:

```text
apps/
  api/       FastAPI service, migrations, API tests, and API scripts
  portal/    Flask shell and static operator UI
deploy/      Compose files, observability, and deployment configuration
examples/    Scenario catalog and seed content
schemas/     Shared JSON schemas
scripts/     Repository maintenance commands
tools/       Provisioning, validation, and operational tools
tests/       Cross-application and repository smoke tests
```

The API image is built from the repository root so it can bundle `schemas/`
and the portal setup assets. The development Compose file bind-mounts
`apps/portal/app` for the portal and the repository root for scenario access.

Future infrastructure services can move under an `infrastructure/` directory
as a separate change. This phase intentionally leaves runtime behavior,
container names, image names, VM names, scenario identifiers, and public API
routes unchanged.
