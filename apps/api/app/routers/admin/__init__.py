"""Admin/setup endpoints for the PVE setup wizard.

Exposed at ``/api/v1/admin/*``. All routes in this module require an
``X-Divide-Token`` header carrying a token whose role is in the
``admin`` allow-list (see :class:`app.core.auth.Role` and
:func:`app.core.auth.require_role`). The gate is registered at the
router level so it's applied uniformly to every endpoint here,
including future additions. Routes:

  * ``GET  /probe``                         — one-shot PVE snapshot
  * ``GET  /storage``                       — list storage pools
  * ``POST /upload-qcow2``                  — upload a cloud image (multipart)
  * ``POST /create-template``               — turn an uploaded qcow2 into a template
  * ``POST /set-template/{vmid}``           — flip template=1 on existing VM
  * ``GET  /progress/{kind}/{job_id}``      — poll a job's status
  * ``GET  /progress``                      — list in-flight jobs
  * ``GET  /drill-template-status``         — does the canonical template exist?
  * ``POST /start-first-drill``             — convenience: run first-live-drill

Security note: this whole module used to be LAN-only. As of L2 2.9
it's hard-gated on admin role. The setup wizard runs in the
operator's browser, mints an admin token via ``tools/issue_token.py``
during step 1, and forwards it on every ``fetch()`` call (see
``README.md §8``). The user-facing portals (``/``)
do not hit any ``/admin/*`` endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import assets, bridges, pve_config, status, wizard

# Modules that hold patchable module-level names (see tests).
SUBMODULES = (wizard, bridges, pve_config, assets, status)

router = APIRouter()
for _module in SUBMODULES:
    router.include_router(_module.router)

__all__ = ["SUBMODULES", "router"]
