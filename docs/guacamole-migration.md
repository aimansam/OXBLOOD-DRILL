# Apache Guacamole Migration

## Architecture

- VM 160 (`cyberdrill-access-gateway`) is dedicated to participant remote
  access.
- `guacamole` and `guacd` run on VM 160 independently of the retired SIEM.
- `eth0` is management (`192.168.0.160`).
- `eth1` is the cyber-drill access path (`10.30.220.20`, VLAN 220).
- VM 160 routes `10.30.0.0/16` through the virtual drill router at `10.30.220.1`.
- Proxmox noVNC remains an Admin/Lead recovery console.

## Current state

- Guacamole 1.5.5 is running with PostgreSQL authentication.
- `guacd` is running.
- Default `guacadmin` credentials were rotated.
- The retired SIEM VM 150 is stopped with automatic boot disabled. Its disks
  are retained; participant access has no dependency on it.
- The virtual drill router is VM 170 and has no connection to the main LAN.
- Compose definition: `deploy/guacamole/docker-compose.yml`.

## Remaining integration

1. Add xrdp to the Linux GUI golden images and verify desktop login.
2. Add the Guacamole API client to OxBlood.
3. Create one short-lived Guacamole connection per drill asset.
4. Grant access according to Red/Blue role and participant assignment.
5. Launch Guacamole from the participant access tile.
6. Delete connections during drill cleanup and record access events.

The participant workflow must not use a shared Guacamole account. Until the
per-user authorization bridge is complete, the existing noVNC endpoint remains
the active participant path.

## File Breach role templates

The File Breach scenario uses dedicated service images for its two exposed
paths:

- `tpl-debian-web-gateway-wazuh` (VM 163): Nginx document portal with access logs.
- `tpl-debian-backup-server-wazuh` (VM 164): Nginx backup manifest/archive portal with access logs.
- `tpl-debian-dmz-docker-wazuh` (VM 171): Docker DMZ with a published web
  frontend and private API, PostgreSQL, and Redis networks.

Both templates were boot-smoke-tested through Proxmox before promotion. The
participant workstations remain `tpl-kali-gui-xrdp` and
`tpl-debian-blue-gui-wazuh-xrdp`.
