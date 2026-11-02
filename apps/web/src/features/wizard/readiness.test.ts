import { describe, expect, it } from 'vitest';
import type { Scenario } from '@/api/types';
import { computeReadiness, validateDetails } from './readiness';

const scenario = {
  id: 1,
  name: 'file-breach',
  spec: { spec: { assets: [{ template: 'tpl-a' }, { template: 'tpl-b' }], networks: [{ name: 'corp', cidr: '10.0.0.0/24' }] } },
} as unknown as Scenario;

const healthy = {
  scenario,
  pve: { node: 'pve1', clone_storage: 'fast', seed_snippet_storage: 'local' },
  templateStatus: { ready: true, template: 'tpl-a', available: ['tpl-b'] },
  pveTemplates: { items: [] },
  bridgePlan: { bridges: [{ name: 'vmbr10', cidr: '10.0.0.0/24', scenario: 'file-breach', network: 'corp' }], conflicts: [] },
  bridgeStatus: { reachable: true, vnets_present: ['vmbr10'], vnets_missing: [] },
  storageStatus: { items: [{ storage: 'local', content: ['iso'] }] },
  preflight: { ready: true, node: 'pve1', checks: [{ ready: true, detail: 'ok' }] },
};

describe('computeReadiness', () => {
  it('is startable when templates, networks and preflight pass', () => {
    const r = computeReadiness(healthy);
    expect(r.startable).toBe(true);
    expect(r.node).toBe('pve1');
    expect(r.networkRows[0]).toMatchObject({ bridge: 'vmbr10', ready: true });
  });

  it('does not require snippet storage (seeding uses the guest agent)', () => {
    // storage "local" does not list "snippets" above and the range is still startable
    expect(computeReadiness(healthy).startable).toBe(true);
  });

  it('is not startable when a template is missing', () => {
    const r = computeReadiness({ ...healthy, templateStatus: { ready: false, available: ['tpl-a'] } });
    expect(r.startable).toBe(false);
    expect(r.templateRows.find((t) => t.name === 'tpl-b')?.ready).toBe(false);
  });

  it('is not startable when a bridge is missing or conflicts exist', () => {
    expect(computeReadiness({ ...healthy, bridgeStatus: { reachable: true, vnets_present: [], vnets_missing: ['vmbr10'] } }).startable).toBe(false);
    expect(computeReadiness({ ...healthy, bridgePlan: { ...healthy.bridgePlan, conflicts: ['clash'] } }).startable).toBe(false);
  });

  it('maps VLAN networks onto the shared bridge', () => {
    const vlanScenario = { ...scenario, spec: { spec: { assets: [], networks: [{ name: 'red', vlan_id: 230 }] } } } as unknown as Scenario;
    const r = computeReadiness({
      ...healthy,
      scenario: vlanScenario,
      bridgePlan: { bridges: [{ name: 'vmbr200', cidr: '', scenario: 'shared', network: 'vlan-aware' }], conflicts: [] },
      bridgeStatus: { reachable: true, vnets_present: ['vmbr200'] },
    });
    expect(r.networkRows[0]).toMatchObject({ bridge: 'vmbr200', ready: true });
  });

  it('collapses repeated Proxmox-down errors into infraDown', () => {
    const down = 'API error: 503 Proxmox not configured';
    const r = computeReadiness({
      ...healthy,
      templateStatus: { ready: false, error: down },
      pveTemplates: { error: down },
      bridgeStatus: { reachable: false, error: 'PROXMOX_HOST is not set' },
      storageStatus: { error: down },
      preflight: { ready: false, node: 'pve', checks: [] },
    });
    expect(r.infraDown).toBe(true);
    expect(r.startable).toBe(false);
  });

  it('does not call a single unrelated error "infra down"', () => {
    expect(computeReadiness({ ...healthy, storageStatus: { error: 'permission denied' } }).infraDown).toBe(false);
  });
});

describe('validateDetails', () => {
  it('requires a title and caps participants at 20', () => {
    expect(validateDetails({ title: ' ', maxParticipants: '10', duration: '60' })).toEqual({ title: 'Title is required' });
    expect(validateDetails({ title: 'x', maxParticipants: '50', duration: '60' }).maxParticipants).toMatch(/1 to 20/);
    expect(validateDetails({ title: 'x', maxParticipants: '21', duration: '60' }).maxParticipants).toBeTruthy();
    expect(validateDetails({ title: 'x', maxParticipants: '20', duration: '60' })).toEqual({});
  });
});
