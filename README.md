# OxBlood Cyber Drill Platform

A comprehensive cyber drill platform for managing training labs, exercises, and Proxmox VE infrastructure.

[![Python](https://img.shields.io/badge/Python-3.10+-blue?logo=python)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi)](https://fastapi.tiangolo.com/)
[![Flask](https://img.shields.io/badge/Flask-000000?logo=flask)](https://flask.palletsprojects.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## What It Does

OxBlood Cyber Drill Platform lets you run structured cybersecurity training — labs, exercises, team competitions, and progress tracking — on your own Proxmox VE infrastructure. Two products share one portal:

- **OxBlood Drill** — the active training platform: dashboards, labs, drills, teams, scoring.
- **OxBlood Learn** — coming soon: learning paths and content management.

## Architecture

```
User Browser (localhost:5000)
  │
  ▼
Flask Portal (port 5000)
  ├── Landing Page — OxBlood branding + product showcase
  ├── Login Page — tabbed auth (Drill active, Learn coming)
  ├── Drill Platform (/drill/*) — dashboard, labs, drills, teams
  └── API Proxy (/api/*) — proxies to FastAPI backend
  │
  ▼
FastAPI Backend (internal:8000) — REST API + Proxmox VE integration
```

## Quickstart

```bash
git clone https://github.com/aimansam/OXBLOOD-DRILL.git
cd OXBLOOD-DRILL
docker compose up -d
# Portal opens at http://localhost:5000
```

## Features

- Drill dashboard — view active drills, participant progress, scores.
- Lab management — provision and control Proxmox VMs per exercise.
- Team mode — group participants, run competitions, track standings.
- REST API — everything accessible programmatically for automation.
- Proxmox VE integration — lifecycle management of training lab VMs.

## License

MIT — see [LICENSE](LICENSE).

*For authorized cybersecurity training and educational purposes only.*
