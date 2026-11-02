"""Connection state and call plumbing shared by the real PVE adapter mixins."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from proxmoxer import ProxmoxAPI

from app.runners.adapter import (
    ProxmoxAdapter,
)
from app.services.proxmox import ProxmoxAPIError, ProxmoxNotConfiguredError

log = logging.getLogger("app.runners.real_adapter")


def _guest_error(value: object, limit: int = 700) -> str:
    """Extract useful PowerShell errors from noisy CLIXML output."""
    text = str(value or "").replace("_x000D_", "").replace("_x000A_", "\n")
    messages = re.findall(r"<S S=\"Error\">(.*?)</S>", text, flags=re.S)
    if messages:
        return " | ".join(messages)[-limit:]
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()[-limit:]


def _is_missing_vm_error(value: object) -> bool:
    """Return true when PVE says the VM configuration is already gone.

    PVE 9 reports a missing VM inconsistently: some endpoints return 404,
    while others return HTTP 500 with a missing ``qemu-server/<vmid>.conf``
    message. Lifecycle teardown must treat both forms as idempotent success.
    """
    message = str(value or "").lower()
    return (
        "not found" in message
        or "no such" in message
        or "does not exist" in message
        or "configuration file" in message
        and "qemu-server" in message
    )


_DEFAULT_TIMEOUT_S = 30.0


class _AdapterCore(ProxmoxAdapter):
    """Connection state and call plumbing shared by the real PVE adapter mixins."""

    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        token_id: str,
        token_secret: str,
        verify_ssl: bool = True,
        node: str | None = None,
        clone_storage: str = "local-lvm",
        seed_snippet_storage: str = "local",
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        if not host:
            raise ProxmoxNotConfiguredError("Proxmox host is empty")
        if not token_id or not token_secret:
            raise ProxmoxNotConfiguredError("Proxmox token_id and token_secret are required")
        self._host = host.split("://", 1)[-1].rstrip("/") if "://" in host else host
        self._port = int(port)
        self._user = user
        # PROXMOX_TOKEN_ID is the full "user!tokenname" string. proxmoxer
        # wants (user, token_name) separately:
        token_full = token_id.strip()
        self._token_name = token_full.split("!", 1)[1] if "!" in token_full else token_full
        self._token_secret = token_secret
        self._verify_ssl = verify_ssl
        self._clone_storage = (clone_storage or "").strip() or "local-lvm"
        self._seed_snippet_storage = (seed_snippet_storage or "").strip() or "local"
        self._timeout_s = float(timeout_s)
        self._client: ProxmoxAPI | None = None
        # Default node for F3 multi-VM scenarios. The runner currently
        # operates on a single node per drill (see runner.py), so we
        # stash that here for create_bridge to use. Tests pass
        # ``node`` explicitly per-call elsewhere, but create_bridge
        # doesn't take a node arg, so we use this for the default.
        self._node: str | None = (node or "").strip() or None

    def set_node(self, node: str) -> None:
        """Set the node used by node-scoped network validation."""
        self._node = (node or "").strip() or None

    async def _call(self, fn, *args: Any, **kwargs: Any) -> Any:
        """Run a sync proxmoxer call in a worker thread with a timeout.

        Any exception raised by `fn` (proxmoxer or anything else) is wrapped
        as `ProxmoxAPIError` so callers have a single error type. 403s get a
        short ACL hint appended so the operator knows to grant PVEVMAdmin.
        """
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(fn, *args, **kwargs),
                timeout=self._timeout_s,
            )
        except ProxmoxNotConfiguredError:
            raise
        except TimeoutError as exc:
            raise ProxmoxAPIError(f"proxmoxer call timed out after {self._timeout_s}s") from exc
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "403" in msg or "Permission check failed" in msg:
                raise ProxmoxAPIError(
                    f"{type(exc).__name__}: {exc} — token needs PVEVMAdmin "
                    f"(or PVEAdmin) on /v2/vm; see PROXMOX-SETUP in README.md §8 §6"
                ) from exc
            raise ProxmoxAPIError(f"{type(exc).__name__}: {exc}") from exc

    @staticmethod
    def _looks_like_windows_template(template_name: str | None) -> bool:
        text = str(template_name or "").lower()
        return "win" in text or "windows" in text

    @staticmethod
    def _primary_disk_key(config: dict) -> str | None:
        for key in ("scsi0", "sata0", "virtio0", "ide0"):
            value = config.get(key)
            if isinstance(value, str) and "cloudinit" not in value.lower():
                return key
        return None

    @staticmethod
    def _cloud_init_storage_id(value: str) -> str | None:
        volume = value.split(",", 1)[0]
        if ":" not in volume:
            return None
        return volume.split(":", 1)[0]

    def _get_client(self) -> ProxmoxAPI:
        """Overridden by RealProxmoxAdapter (kept there so tests can patch ``ProxmoxAPI``)."""
        raise NotImplementedError
