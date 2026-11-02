# OxBlood web (React)

The redesigned UI, served by the Flask portal at `/app/` next to the classic portal at `/drill/`.
Pages are migrated one by one; items that are not migrated yet open the classic portal.
Both UIs share the same sign-in (`localStorage.divide_token`).

Stack: React 18, TypeScript, Vite, React Router, TanStack Query, Tailwind with shadcn-style
components, `openapi-fetch` for a typed API client.

    npm ci
    npm run dev          # http://localhost:5173/app/ ; proxies /api to http://localhost:5000
    npm test             # vitest
    npm run typecheck && npm run lint && npm run build

Dev against another backend: `VITE_API_PROXY=http://host:port npm run dev`.

## API types
`src/api/schema.d.ts` is generated from `openapi.json`, which is exported from the FastAPI app:

    python3 tools/export_openapi.py     # from the repo root; rewrites apps/web/openapi.json
    npm run gen:api                     # regenerates src/api/schema.d.ts

CI fails if either file is stale. An endpoint only has useful types once it declares a
`response_model` in the API; add one before using a new endpoint from the UI.

## Layout
- `src/api` client, error formatting, token storage, query hooks
- `src/components` app shell and shared pieces; `src/components/ui` base components
- `src/features/<page>` one folder per screen
- Design tokens are CSS variables in `src/index.css`, mapped in `tailwind.config.ts`.

The production build is baked into the portal image (`apps/portal/Dockerfile`), not committed.

## Browser tests
`e2e/` holds Playwright tests that drive the production build against a throwaway stack
(the real API on SQLite with the mock Proxmox adapter, behind the Flask portal). They need a Redis
and the Python dependencies of `apps/api` and `apps/portal`:

    docker run -d --rm --name oxb-redis -p 127.0.0.1:6399:6379 redis:7-alpine
    npm run test:e2e                      # builds, starts API + portal on :8100/:5100, runs the suite
    DIVIDE_REDIS_URL=redis://127.0.0.1:6379/0 E2E_PYTHON=.venv/bin/python npm run test:e2e

An already running stack on those ports is reused locally; CI always starts a fresh one.
