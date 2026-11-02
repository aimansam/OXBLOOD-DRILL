# Operations runbook

## Before a drill
1. `python tools/range_dry_run.py --scenario <name>` prepares the range, validates every VM, then
   tears it down. Add `--keep` to leave it running. It creates real VMs.
2. With a range up, `python tools/isolation_check.py --pve-host <ip>` tests from inside the red VMs
   that the Proxmox web UI and SSH (and any `--block HOST:PORT` you add) are unreachable.

## Always on
- **Health:** the portal `/healthz` returns 503 when it cannot serve the React build's `index.html`.
  The build is baked into the portal image (no bind mount), so a git checkout cannot break it;
  rebuild with `docker compose -f deploy/docker-compose.yml build portal` to ship UI changes.
- **Backups:** `scripts/backup_db.sh` (see `deploy/backup/README.md`). Test a restore occasionally.
- **Alerts:** rules in `deploy/prometheus/alerts.yml`, routed by `deploy/alertmanager/alertmanager.yml`.
  Edit the `default` receiver there to get Discord, Telegram or email notifications.

## Applying deploy changes
    docker compose -f deploy/docker-compose.yml up -d prometheus alertmanager
