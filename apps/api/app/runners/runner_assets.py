"""Per-asset spawn, guest seeding and network attachment for the run orchestrator."""

from __future__ import annotations

import ipaddress
import logging
import secrets

from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models
from app.db.models import AssetStatus, AuditAction
from app.runners.adapter import CloneSpec, SeedSpec
from app.runners.runner_base import (
    RunnerBase,
    RunnerError,
    _static_ip_configs,
    _vm_name,
)

log = logging.getLogger("app.runners.runner")


class AssetSeedingMixin(RunnerBase):
    """Per-asset spawn, guest seeding and network attachment for the run orchestrator."""

    async def _spawn_asset(
        self,
        session: AsyncSession,
        asset: models.Asset,
        asset_spec: dict,
        node: str,
        actor: str | None = None,
    ) -> None:
        log.info(
            "runner.spawn_asset_start role=%s template=%s run_id=%s",
            asset.role,
            asset.template,
            asset.run_id,
        )

        async with self._pve_lifecycle_section("clone", run_id=asset.run_id, role=asset.role):
            template_vmid = await self._adapter.find_template(asset.template)
            if template_vmid is None:
                raise RunnerError(
                    f"template {asset.template!r} not found on PVE (role={asset.role!r})"
                )
            log.info(
                "runner.template_found role=%s template_vmid=%s",
                asset.role,
                template_vmid,
            )

            new_vmid = await self._adapter.allocate_vmid()
            log.info("runner.vmid_allocated role=%s new_vmid=%s", asset.role, new_vmid)

            resources = asset_spec.get("resources") or {}
            provisioning = (getattr(asset, "_divide_scenario_spec", {}) or {}).get(
                "provisioning", {}
            ) or {}
            linked_clone = provisioning.get("mode") == "linked_clone"
            # PVE 9 enforces strict DNS-1123 names on the clone VMID; underscores
            # in the role (e.g. ``drill_vm``) violate that. We strip them from
            # Keep the stable role in the DB while using the short name in PVE.
            role = asset.role
            sanitized_role = _vm_name(asset_spec, role) or role.replace("_", "")
            clone = CloneSpec(
                source_vmid=template_vmid,
                new_vmid=new_vmid,
                node=node,
                name=f"divide-{asset.run_id}-{sanitized_role}",
                template_name=asset.template,
                cores=resources.get("cores"),
                sockets=resources.get("sockets"),
                ram_mb=resources.get("ram_mb"),
                disk_gb=resources.get("disk_gb"),
                ip_configs=_static_ip_configs(
                    asset_spec, getattr(asset, "_divide_scenario_spec", {}) or {}
                ),
                full_clone=not linked_clone,
            )
            asset.status = AssetStatus.CLONING
            await session.flush()

            log.info("runner.cloning_vm role=%s new_vmid=%s", asset.role, new_vmid)
            result = await self._adapter.clone_vm(clone)
            asset.pve_vmid = result.vmid
            asset.pve_node = result.node
            asset.status = AssetStatus.BOOTING
            await session.flush()
            # Publish clone progress immediately. Provisioning can take
            # several minutes and the operator UI must not wait for the
            # entire run transaction to finish before seeing this VM.
            await session.commit()
            log.info("runner.clone_complete role=%s vmid=%s", asset.role, result.vmid)

        seed = self._build_seed_spec(
            asset=asset,
            asset_spec=asset_spec,
            scenario_spec=getattr(asset, "_divide_scenario_spec", {}) or {},
        )
        async with self._pve_lifecycle_section(
            "boot", run_id=asset.run_id, role=asset.role, vmid=result.vmid
        ):
            # F3 multi-VM scenarios: attach NICs before the first boot.
            # Cloud-init/Linux guests discover NICs during early boot; adding
            # scenario bridges after start can leave the guest without DHCP/IP
            # and makes the UI look like the VM failed to boot.
            await self._attach_asset_networks(
                asset=asset,
                asset_spec=asset_spec,
                bridges_by_name=asset._f3_bridges_by_name,  # type: ignore[attr-defined]
                node=node,
            )
            await session.flush()

            if seed is not None:
                log.info("runner.seeding_vm role=%s vmid=%s", asset.role, result.vmid)
                await self._adapter.seed_vm(result.vmid, result.node, seed)

            log.info("runner.starting_vm role=%s vmid=%s", asset.role, result.vmid)
            await self._adapter.start_vm(result.vmid, result.node)
            log.info("runner.vm_started role=%s vmid=%s", asset.role, result.vmid)

            if seed is not None:
                await self._adapter.apply_guest_seed(result.vmid, result.node, seed)

            windows_verify = (asset_spec.get("windows_setup") or {}).get("verify") or {}
            if windows_verify:
                await self._adapter.verify_windows_role(
                    result.vmid,
                    result.node,
                    expected_ip=str(windows_verify.get("ip") or ""),
                    domain=str(windows_verify.get("domain") or ""),
                    controller=str(windows_verify.get("controller") or "member"),
                )
                log.info(
                    "runner.windows_verified role=%s vmid=%s ip=%s domain=%s controller=%s",
                    asset.role,
                    result.vmid,
                    windows_verify.get("ip"),
                    windows_verify.get("domain"),
                    windows_verify.get("controller", "member"),
                )

            state = await self._adapter.get_vm_state(result.vmid, result.node)
            log.info(
                "runner.vm_state role=%s vmid=%s status=%s ip=%s",
                asset.role,
                result.vmid,
                state.status,
                state.ip,
            )

            asset.pve_ip = state.ip
            asset.status = AssetStatus.RUNNING if state.status == "running" else AssetStatus.STOPPED
            await session.flush()

        await self._audit(
            session,
            action=AuditAction.ASSET_SPAWNED,
            actor=actor,
            run_id=asset.run_id,
            asset_id=asset.id,
            details={
                "role": asset.role,
                "vmid": result.vmid,
                "ip": state.ip,
                "seeded": seed is not None,
                "seed_files": len((seed.files if seed else {}) or {}),
                "seed_commands": len((seed.runcmd if seed else []) or []),
            },
        )
        # Make the completed machine visible before the next asset starts.
        await session.commit()

    def _build_seed_spec(
        self,
        *,
        asset: models.Asset,
        asset_spec: dict,
        scenario_spec: dict,
    ) -> SeedSpec | None:
        template = str(asset_spec.get("template") or asset.template or "").lower()
        if str(asset_spec.get("network_mode") or "").lower() == "trunk" or "opnsense" in template:
            log.info(
                "runner.seed.skip_firewall_appliance role=%s template=%s",
                asset.role,
                asset_spec.get("template") or asset.template,
            )
            return None
        windows_setup = asset_spec.get("windows_setup") or {}
        if ("win" in template or "windows" in template) and not bool(
            asset_spec.get("cloudbase_init")
            or asset_spec.get("cloudinit")
            or windows_setup.get("commands")
            or windows_setup.get("phases")
        ):
            log.info(
                "runner.seed.skip_windows_template role=%s template=%s",
                asset.role,
                asset_spec.get("template") or asset.template,
            )
            return None

        role = str(asset.role or asset_spec.get("role") or "asset")
        base_role = str(asset_spec.get("role") or role)
        access = asset_spec.get("access") or {}
        if role.startswith("red") or base_role.startswith("red"):
            ciuser = str(access.get("user") or "red")
            cipassword = str(access.get("password") or "red-team")
        elif role.startswith("blue") or base_role.startswith("blue"):
            ciuser = str(access.get("user") or "blue")
            cipassword = str(access.get("password") or "blue-team")
        else:
            ciuser = str(access.get("user") or "divide")
            cipassword = str(access.get("password") or "divide")

        objectives = scenario_spec.get("objectives") or {}
        files: dict[str, str] = {
            "/opt/divide/role.txt": role + "\n",
            "/opt/divide/objectives-red.txt": "\n".join(objectives.get("red") or []) + "\n",
            "/opt/divide/objectives-blue.txt": "\n".join(objectives.get("blue") or []) + "\n",
        }

        matched_flags = []
        for flag in scenario_spec.get("flags") or []:
            planted = str(flag.get("planted_on_role") or "")
            if planted and (
                planted == role or planted == base_role or role.startswith(planted + "_")
            ):
                matched_flags.append(flag)

        for flag in matched_flags:
            flag_id = str(flag.get("id") or "flag")
            files[f"/opt/divide/flags/{flag_id}.txt"] = str(flag.get("value") or "") + "\n"

        # Compact ranges keep Blue-team evidence on the investigation
        # workstation instead of dedicating a separate log-aggregator VM.
        # The bundle is only written when Blue flags are intentionally
        # planted on that workstation, so other scenarios retain their
        # existing topology and evidence flow.
        if base_role == "blue_workstation" and any(
            str(flag.get("side") or "") == "blue" for flag in matched_flags
        ):
            files["/opt/divide/evidence/incident-timeline.log"] = (
                "2026-01-01T09:12:44Z red_vlan workstation initiated HTTPS to dmz_gateway\n"
                "2026-01-01T09:18:07Z dmz_gateway authenticated to dc01 over WinRM\n"
                "2026-01-01T09:26:31Z file_server recorded unusual archive access\n"
                "2026-01-01T09:31:52Z backup_server received a protected-path access attempt\n"
            )

        runcmd = [
            "mkdir -p /opt/divide/flags",
            "mkdir -p /opt/divide/evidence",
            "chmod -R 700 /opt/divide",
            "sysctl --system || true"
            if base_role == "router_fw" and "opnsense" not in template
            else "true",
        ]
        domain_password = self._windows_setup_secrets.setdefault(
            asset.run_id, f"D1videLab-{secrets.token_urlsafe(18)}!"
        )

        def render_windows_command(command: object) -> str:
            return str(command).replace("{{domain_password}}", domain_password)

        windows_commands = [
            render_windows_command(command)
            for command in (windows_setup.get("commands") or [])
            if str(command).strip()
        ]
        windows_phases: list[dict] = []
        for phase in windows_setup.get("phases") or []:
            if not isinstance(phase, dict):
                continue
            phase_commands = [
                render_windows_command(command)
                for command in (phase.get("commands") or [])
                if str(command).strip()
            ]
            if phase_commands:
                windows_phases.append(
                    {
                        "name": str(phase.get("name") or f"phase-{len(windows_phases) + 1}"),
                        "commands": phase_commands,
                        "reboot": bool(phase.get("reboot")),
                        "timeout_seconds": int(phase.get("timeout_seconds") or 900),
                    }
                )

        log.info(
            "runner.seed.plan role=%s template=%s windows_commands=%s windows_phases=%s files=%s commands=%s",
            role,
            asset_spec.get("template") or asset.template,
            len(windows_commands),
            len(windows_phases),
            len(files),
            len(runcmd),
        )

        # Compatibility while legacy golden images are replaced. Remove the
        # retired agent on disposable Linux clones without deleting log data.
        if "win" not in template and "windows" not in template:
            runcmd.insert(
                0,
                "if command -v dpkg-query >/dev/null 2>&1 && "
                "dpkg-query -W -f='${Status}' wazuh-agent 2>/dev/null | grep -q 'ok installed$'; then "
                "DEBIAN_FRONTEND=noninteractive dpkg --remove wazuh-agent; fi",
            )

        # Intermediate file-breach scenarios use the blue log aggregator as
        # the investigation trail. Forward local syslog over TCP when the
        # scenario declares that role so telemetry is real, not decorative.
        log_asset = next(
            (
                candidate
                for candidate in (scenario_spec.get("assets") or [])
                if str(candidate.get("role") or "") == "log_aggregator"
            ),
            None,
        )
        if log_asset and base_role != "log_aggregator":
            log_networks = log_asset.get("networks") or []
            scenario_networks = {
                str(net.get("name")): net
                for net in (scenario_spec.get("networks") or [])
                if isinstance(net, dict)
            }
            log_network = scenario_networks.get(str(log_networks[0])) if log_networks else None
            if log_network and log_network.get("cidr"):
                try:
                    log_hosts = list(
                        ipaddress.ip_network(str(log_network["cidr"]), strict=False).hosts()
                    )
                    if len(log_hosts) > 30:
                        files["/etc/rsyslog.d/30-divide-forward.conf"] = (
                            f"*.* @@{log_hosts[30]}:514\n"
                        )
                        runcmd.append("systemctl restart rsyslog || true")
                except (ValueError, TypeError):
                    log.warning("runner.telemetry.invalid_log_network role=%s", role)

        event_log_by_role = {
            "web_gateway": "/var/log/divide-web-events.log",
            "file_server": "/var/log/divide-file-events.log",
            "backup_server": "/var/log/divide-backup-events.log",
        }
        event_log = event_log_by_role.get(base_role)
        if event_log:
            files[event_log] = (
                f"divide scenario asset={base_role} event=seeded\n"
                f"divide scenario asset={base_role} event=ready\n"
            )
            runcmd.append(f"logger -t divide-{base_role} scenario_asset_ready || true")

        if (
            base_role == "router_fw"
            and "opnsense" not in template
            and str(asset_spec.get("network_mode") or "").lower() != "trunk"
        ):
            files["/etc/sysctl.d/99-divide-router.conf"] = (
                "net.ipv4.ip_forward=1\n"
                "net.ipv4.conf.all.rp_filter=0\n"
                "net.ipv4.conf.default.rp_filter=0\n"
            )
            routing = scenario_spec.get("routing_policy") or {}
            network_interfaces = {
                str(network): f"eth{index}"
                for index, network in enumerate(asset_spec.get("networks") or [])
            }
            nft_rules = [
                "table inet divide {",
                "  chain input { type filter hook input priority 0; policy accept; }",
                "  chain output { type filter hook output priority 0; policy accept; }",
                "  chain forward {",
                f"    type filter hook forward priority 0; policy {routing.get('default_forward', 'drop')};",
                "    ct state established,related accept",
            ]
            for rule in routing.get("rules") or []:
                source = network_interfaces.get(str(rule.get("from")))
                target = network_interfaces.get(str(rule.get("to")))
                if not source or not target:
                    continue

                def render_port(port: object) -> str:
                    value = str(port).strip()
                    if "-" in value:
                        start, end = value.split("-", 1)
                        return f"{int(start)}-{int(end)}"
                    return str(int(value))

                ports = ", ".join(render_port(port) for port in rule.get("ports") or [])
                if ports:
                    ports_expr = ports if len(rule.get("ports") or []) == 1 else f"{{ {ports} }}"
                    nft_rules.append(
                        f'    iifname "{source}" oifname "{target}" '
                        f"{rule.get('protocol')} dport {ports_expr} accept"
                    )
            nft_rules.extend(["  }", "}", ""])
            files["/etc/nftables.d/divide-policy.nft"] = "\n".join(nft_rules)
            runcmd.append("nft -f /etc/nftables.d/divide-policy.nft")

        return SeedSpec(
            role=role,
            ciuser=ciuser,
            cipassword=cipassword,
            files=files,
            runcmd=runcmd,
            windows_commands=windows_commands or None,
            windows_phases=windows_phases or None,
        )

    async def _attach_asset_networks(
        self,
        *,
        asset: models.Asset,
        asset_spec: dict,
        bridges_by_name: dict[str, str],
        node: str,
    ) -> None:
        """F3: attach NICs to the bridges this asset declares.

        Iterates ``asset_spec.networks[]`` in declaration order,
        records each as an additional NIC on the freshly cloned VM.
        Silently skips networks whose name is not in
        ``bridges_by_name`` (the runner validates the network
        declarations exist before this is called, so this should be
        unreachable in practice — but we don't want a typo to
        brick the runner with a KeyError here).
        """
        asset_networks = asset_spec.get("networks") or []
        vlan_by_name = getattr(asset, "_f3_vlan_by_name", {})
        network_mode = str(asset_spec.get("network_mode") or "").lower()
        template = str(asset_spec.get("template") or asset.template or "").lower()
        if network_mode == "trunk" or "opnsense" in template:
            vlan_ids = [vlan_by_name.get(str(net_name)) for net_name in asset_networks]
            trunk_vlans = sorted({int(vlan_id) for vlan_id in vlan_ids if vlan_id is not None})
            if not trunk_vlans:
                raise RunnerError(f"router asset {asset.role!r} has no VLAN IDs for trunk mode")
            bridge = bridges_by_name.get(str(asset_networks[0])) if asset_networks else None
            if bridge is None:
                raise RunnerError(f"router asset {asset.role!r} has no attached networks")
            await self._adapter.attach_network(
                asset.pve_vmid,  # type: ignore[arg-type]
                node,
                bridge,
                0,
                trunks=trunk_vlans,
            )
            log.info(
                "runner.networks.attached_trunk role=%s vmid=%s bridge=%s vlans=%s",
                asset.role,
                asset.pve_vmid,
                bridge,
                trunk_vlans,
            )
            return
        for nic_id, net_name in enumerate(asset_networks):
            bridge = bridges_by_name.get(net_name)
            if bridge is None:
                log.warning(
                    "runner.networks.unknown_network role=%s network=%s (bridge not found)",
                    asset.role,
                    net_name,
                )
                continue
            await self._adapter.attach_network(
                asset.pve_vmid,  # type: ignore[arg-type]
                node,
                bridge,
                nic_id,
                vlan_id=vlan_by_name.get(net_name),
            )
            log.info(
                "runner.networks.attached role=%s vmid=%s bridge=%s nic_id=%s",
                asset.role,
                asset.pve_vmid,
                bridge,
                nic_id,
            )
