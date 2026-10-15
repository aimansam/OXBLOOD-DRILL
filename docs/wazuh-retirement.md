# Wazuh Retirement

## Implemented

- Removed manager startup, enrollment generation, and manager preflight checks.
- Removed Wazuh sinks from catalog scenarios and the supported sink schema.
- Replaced Wazuh-specific investigation objectives with native log investigation.
- Preserved native guest logs, the existing TCP syslog forwarding path, MinIO
  artifact declarations, and historical drill records.
- Linux disposable clones remove the Debian `wazuh-agent` package during guest
  seeding. Removal errors fail seeding. Package configuration and logs are retained;
  this is not a purge of historical evidence. No online package download is needed.

## Infrastructure

The owner confirmed the separate Docker stack is exclusive to OxBlood and approved
stopping it while retaining data. The three existing containers are stopped with
restart disabled in both Docker and their source Compose file. Volumes are retained.
The Compose project lives at `/DATA/Storage/docker/wazuh-docker/single-node`.

The Proxmox manager is VM 150, `wazuh-cyberdrill`. It was already stopped and had
16 GiB configured RAM; disabling its onboot setting prevents automatic boot.
No VM disks, container volumes, certificates, or evidence were deleted.

## Deliberately Retained

Existing `*-wazuh` template names remain valid PVE references. Renaming YAML alone
would break cloning. Golden images still need offline agent/configuration cleanup
and certification before replacement/renaming. Windows agent presence must be
audited separately; no Windows package removal is claimed by this change.

The existing forwarding code is preserved, not certified as end-to-end delivery.
Windows event logs remain local until export/forwarding is validated. Historical
drill objectives may still mention Wazuh; they are not rewritten retroactively.

## Acceptance Still Required

1. Verify preflight RAM permissions and clone storage capacity.
2. Provision a fresh range and verify Linux package removal, native log retention,
   DC01 readiness, desktops, and a tagged event reaching the log aggregator.
3. Complete prepare/start/stop/cleanup three times without Wazuh.
4. Only after certification, replace golden images and request explicit approval
   before deleting retired infrastructure/data.

Stopping Docker reclaimed approximately 1.47 GiB of measured container usage at
retirement. The already-stopped 16 GiB PVE VM contributed no additional immediate
saving; preventing its future startup avoids that allocation on the hypervisor.
These are different hosts/resource pools and must not be added as immediate savings.
