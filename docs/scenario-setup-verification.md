# Scenario setup verification — 27 October 2026

This is a read-only check of the scenario YAML, catalog database, and Proxmox
configuration. No range VMs were started, no services were probed, and no
weakness was exploited.

## Evidence levels

- **Verified setup:** A named PVE VM, template, snapshot, or NIC configuration
  was observed through the PVE API.
- **Declared path:** A network, route, service check, or objective appears in
  scenario YAML; it has not been tested end to end.
- **Unverified weakness:** The vulnerable service/version and exploit path have
  not been demonstrated on the deployed image. A route or flag is not proof of
  vulnerability.

## Catalog findings

| Organization | PVE templates | Snapshot baselines | Live path / weakness |
| --- | --- | --- | --- |
| Kumpulan Bintang Utara | 7/7 present | 7/7 ready in DB; six `clean-baseline` snapshots observed, router marked persistent | Not tested; seven baseline VMs stopped |
| Syarikat Karya Bestari | 7/7 present | None | Not tested |
| Pusat Kesihatan Seri Melur | 5/5 present | None | Not tested; no flags or validation probes declared |
| Makmal Pesisir | 5/5 present | None | Not tested |

The four scenario files have empty `vulnerabilities` lists. They contain no
verified CVE or confirmed entry weakness.

## Kumpulan Bintang Utara: observed VM layout

| Role | VMID | PVE state | Declared network | Observed NIC |
| --- | ---: | --- | --- | --- |
| red_workstation | 106 | stopped | red_vlan | vmbr200, VLAN 230 |
| router_fw | 107 | stopped | trunk | vmbr200, untagged trunk NIC |
| dmz_gateway | 108 | stopped | dmz_vlan | vmbr200, VLAN 231 |
| dc01 | 109 | stopped | dc01_vlan | vmbr200, VLAN 234 |
| file_server | 116 | stopped | dc01_vlan | vmbr200, VLAN 234 |
| backup_server | 117 | stopped | backup_vlan | vmbr200, VLAN 236 |
| blue_workstation | 118 | stopped | dc01_vlan | vmbr200, VLAN 234 |

The scenario declares Red-to-DMZ TCP 80/443, DMZ-to-identity TCP
445/5985/5986, and identity-to-backup TCP 22/443/873. These are declared
routes, not a verified firewall configuration or proof that the destination
services listen. OPNsense guest seeding is skipped by the runner, so inspect
the persistent router configuration when validating this path.

## What must be checked before marking an attack step verified

1. Restore the range in a controlled exercise window and confirm each guest
   reaches its declared VLAN with the expected address.
2. Check the actual listening service and version at the target, and test the
   intended route from the preceding machine.
3. Confirm the intended weakness on the deployed guest image. Record the
   affected service, version, evidence, and CVE only if one applies.
4. Complete the corresponding Red objective, confirm the Blue evidence is
   produced, and reset the range to its baseline.

Until these checks pass, the Organizations page describes **declared setup**
and displays **Weakness: Not verified** for every attack-path target.
