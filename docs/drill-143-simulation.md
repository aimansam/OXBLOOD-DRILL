# Controlled Red/Blue simulation — drill 143

Run on 27 October 2026 (Malaysia time) against the `enterprise-file-breach`
scenario for Kumpulan Bintang Utara. This was an operator-driven exercise using
dedicated Red and Blue simulation accounts. The accounts were disabled after
the run; no real participant account was used.

## Outcome

- Drill 143 was prepared and started on run 258. All seven snapshot baseline
  VMs were running, and the platform readiness check reported ready.
- RED01 (`10.30.10.10`) reached DMZ01 (`10.30.20.40`) on TCP/80 and received
  HTTP 200 for `GET /`. DMZ01's `dmz-web-1` access log recorded source
  `10.30.10.10` and the simulation user agent.
- TCP/443 at DMZ01 refused the connection. RED01's direct TCP/445 probe to
  DC01 timed out. No exploit, foothold, identity pivot, file access, backup
  access, or CVE was verified.
- Acting as Blue, the operator identified the Red source from the real web
  access log, then added a temporary `DOCKER-USER` rule on DMZ01 to reject
  RED01 TCP/80. RED01's retry was refused while DMZ01's local web service
  still returned HTTP 200. The rule was removed before cleanup.
- The Red web-reach objective was marked complete. Blue detection and
  containment milestones awarded 15 and 40 points respectively. No flags
  were submitted.
- The simulation and evidence were recorded in drill 143's timeline. The
  drill was stopped with `cleanup_status=stopped`; the environment lock was
  released, and all seven VMs were stopped. The test accounts are disabled.

## Readiness issue found

RED01 initially had only a loopback address inside the guest, although the
platform showed its configured `10.30.10.10` address. Its existing cloud-init
netplan file had not been applied after snapshot restore. Running `netplan
apply` inside RED01 brought up `eth0` with the intended address. The scenario
now declares this command for future baseline restores. The runner also
reapplies short PVE names after cleanup snapshot rollbacks, which otherwise
reverted six names. These fixes were deployed after drill 143 ended.

## Follow-up verification — drill 144

The second run prepared seven baseline VMs and started without manual guest
network configuration. RED01's `eth0` had `10.30.10.10/24` and its default
route immediately after restore. RED01 fetched the DMZ home page and
`/documents/` (HTTP 200), then retrieved the 103-byte
`/documents/operations.txt` file. The DMZ web container logged that request
from `10.30.10.10`. BLUE01 reached DC01 on TCP/53 and TCP/389.

Blue again used a temporary source-specific firewall rule. The Red document
retry was refused while the DMZ local document service remained available.
The rule was removed before stopping the run. Blue's detection and containment
milestones earned 25 and 40 points. No flags were submitted, and the document
access alone is not proof of a vulnerability or deeper compromise.

After drill 144 stopped, `cleanup_status=stopped` and the environment lock was
released. All seven baseline VMs were stopped and retained their short names:
RED01, FW01, DMZ01, DC01, FILE01, BAK01, and BLUE01. The simulation accounts
were disabled again.
