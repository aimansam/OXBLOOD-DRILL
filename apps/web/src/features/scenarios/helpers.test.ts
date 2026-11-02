import { describe, expect, it } from 'vitest';
import type { Scenario } from '@/api/types';
import { attackPath, defaultDrillTitle, initials, networkRefs, pathSetup, scenarioVmLabel, summaryStats, templateRefs, vmLabel } from './helpers';

const scenario = {
  id: 1,
  name: 'file-breach',
  title: 'Enterprise File Breach',
  organization: 'Kumpulan Bintang Utara',
  spec: {
    spec: {
      assets: [
        { role: 'kali', vm_name: 'kali', template: 'tpl-kali', networks: ['red'] },
        { role: 'web', vm_name: 'web', count: 3, template: 'tpl-web', networks: ['dmz'] },
        { role: 'web', template: 'tpl-web' },
      ],
      networks: [{ name: 'red', cidr: '10.0.0.0/24', vlan_id: 230 }, { name: 'dmz' }],
      attack_path: [{ asset: 'kali', goal: 'Scan' }],
      objectives: { red: ['a'], blue: ['b', 'c'] },
      flags: [{}, {}],
      routing_policy: { rules: [{ from: 'red', to: 'red', protocol: 'tcp', ports: [22, 80] }] },
      validation: { probes: [{ role: 'kali', type: 'tcp_connect', port: 22 }] },
    },
  },
} as unknown as Scenario;

describe('scenario helpers', () => {
  it('builds titles and initials from the organization', () => {
    expect(defaultDrillTitle(scenario)).toBe('Kumpulan Bintang Utara — Enterprise File Breach');
    expect(initials(scenario)).toBe('KB');
  });
  it('uses the exercise name when there is no distinct organization', () => {
    const plain = { id: 2, name: 'x', title: 'Solo' } as unknown as Scenario;
    expect(defaultDrillTitle(plain)).toBe('Solo Drill');
  });
  it('de-duplicates template references and reads networks', () => {
    expect(templateRefs(scenario)).toEqual(['tpl-kali', 'tpl-web']);
    expect(networkRefs(scenario)).toEqual([
      { name: 'red', cidr: '10.0.0.0/24', vlan_id: 230 },
      { name: 'dmz', cidr: '', vlan_id: null },
    ]);
  });
  it('counts assets by their count, and objectives across both sides', () => {
    expect(summaryStats(scenario)).toEqual({ assets: 5, networks: 2, flags: 2, objectives: 3 });
  });
  it('labels counted VMs as a range', () => {
    expect(vmLabel({ vm_name: 'web', count: 3, role: 'web' })).toBe('web01–web03');
    expect(vmLabel({ vm_name: 'web', count: 3, role: 'web_2' }, 'web_2')).toBe('web02');
    expect(vmLabel({ role: 'blue_workstation' })).toBe('blue workstation');
    expect(scenarioVmLabel(scenario, 'web_3')).toBe('web03');
  });
  it('describes an attack-path step from the declared setup', () => {
    expect(attackPath(scenario)).toHaveLength(1);
    expect(pathSetup(scenario, 'kali')).toEqual({ network: 'red · VLAN 230', route: 'red → red TCP 22/80', check: 'TCP :22' });
    expect(pathSetup(scenario, 'ghost').network).toBe('Asset not declared');
  });
});
