# Organization and exercise briefing

Each scenario file describes one exercise in a fictional organization. Keep
`metadata.name` as the stable technical slug; changing it creates a new catalog
record. The participant-facing identity lives in these fields:

```yaml
metadata:
  organization: "Kumpulan Bintang Utara" # primary catalog label
  title: "Enterprise File Breach"     # exercise name
  summary: "Red enters through the DMZ; Blue investigates and contains the path."

spec:
  assets:
    - role: dc01                      # stable internal key
      vm_name: DC01                  # short name in UI and PVE
      kind: vm
      template: tpl-win2022-ad-auto
      networks: [dc01_vlan]
  attack_path:
    - asset: dmz_gateway
      goal: "Reach the exposed web service"
    - asset: file_server
      goal: "Access protected files"
  play_guide:
    red:
      - "Inspect the DMZ service from the assigned workstation."
      - "Follow the intended path and record each flag."
    blue:
      - "Watch DMZ and firewall events for the first suspicious source."
      - "Trace movement and preserve evidence before containment."
  vulnerabilities:
    - asset: dmz_gateway
      issue: "Documented weakness or misconfiguration"
      detail: "Explain the affected service, version, and expected attack path."
      cve_ids: []                      # add verified CVE IDs when applicable
```

The page shows a short intended attack path and then separately lists verified
weaknesses and any CVE IDs. Each `attack_path.asset` must match an asset role
in the same scenario. A path step describes a goal, not a proven exploit.
Keep `role` stable when renaming a VM; baseline snapshots, flags, and scoring
reference it. `vm_name` changes the PVE display name and portal label, not the
guest operating system hostname. New per-run clones also retain a run prefix
in PVE so names remain unique. For an asset with `count: 3`, use
a stem such as `PC` to display PC01–PC03.
Use `restore_commands` only for commands needed after a snapshot rollback;
the Enterprise File Breach RED01 baseline reapplies its existing netplan file
so its guest interface receives the declared address.
The path's setup line is derived from declared asset networks, routing rules,
and validation probes. It does not attest that the service is live; record
dated PVE and guest checks separately before calling a path verified.
A blank `vulnerabilities` list displays an explicit "not verified" state.
`play_guide` contains one to four short steps per team. The Organizations page
shows both guides; My Mission shows only the participant's team guide.
Only attach a CVE after confirming the vulnerable
software and version in the deployed range image; a simulated weakness or
misconfiguration may have no CVE.
