import type { Scenario } from '@/api/types';

// Ports of the classic portal's scenario helpers (ui-scenarios.js / ui-create-wizard.js).
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function runtimeSpec(scenario: Scenario | undefined | null): Loose {
  const spec = (scenario?.spec ?? {}) as Loose;
  return spec.spec && typeof spec.spec === 'object' ? spec.spec : spec;
}

export function scenarioName(scenario: Scenario | undefined | null): string {
  const s = scenario as Loose | undefined | null;
  return (s && (s.title || s.display_name || s.name || s.metadata_name)) || 'Scenario';
}

export function organization(scenario: Scenario | undefined | null): string {
  const metadata = ((scenario?.spec as Loose | undefined)?.metadata ?? {}) as Loose;
  return scenario?.organization || metadata.organization || scenarioName(scenario);
}

export function summary(scenario: Scenario | undefined | null): string {
  const s = scenario as Loose | undefined | null;
  const metadata = (s?.spec?.metadata ?? {}) as Loose;
  return s?.summary || metadata.summary || s?.description || s?.summary_text || 'Exercise briefing has not been documented.';
}

export function defaultDrillTitle(scenario: Scenario | undefined | null): string {
  const exercise = scenarioName(scenario);
  const org = organization(scenario);
  return org === exercise ? `${exercise} Drill` : `${org} — ${exercise}`;
}

export function initials(scenario: Scenario | undefined | null): string {
  return organization(scenario)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

export function templateRefs(scenario: Scenario | undefined | null): string[] {
  const assets = (runtimeSpec(scenario).assets ?? []) as Loose[];
  const refs = assets.map((a) => a && (a.template || a.template_id || a.image)).filter(Boolean) as string[];
  return Array.from(new Set(refs));
}

export interface NetworkRef {
  name: string;
  cidr: string;
  vlan_id: number | null;
}

export function networkRefs(scenario: Scenario | undefined | null): NetworkRef[] {
  const networks = (runtimeSpec(scenario).networks ?? []) as Loose[];
  return networks
    .filter((n) => n && n.name)
    .map((n) => ({ name: n.name, cidr: n.cidr || '', vlan_id: n.vlan_id == null ? null : Number(n.vlan_id) }));
}

export function summaryStats(scenario: Scenario | undefined | null) {
  const runtime = runtimeSpec(scenario);
  const assets = (runtime.assets ?? []) as Loose[];
  const objectives = (runtime.objectives ?? {}) as Loose;
  return {
    assets: assets.reduce((sum, a) => sum + Math.max(1, parseInt(a.count || 1, 10)), 0),
    networks: ((runtime.networks ?? []) as unknown[]).length,
    flags: ((runtime.flags ?? []) as unknown[]).length,
    objectives: ((objectives.red ?? []) as unknown[]).length + ((objectives.blue ?? []) as unknown[]).length,
  };
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function vulnerabilities(scenario: Scenario | undefined | null): Row[] {
  const rows = (scenario as Row | undefined | null)?.vulnerabilities || runtimeSpec(scenario).vulnerabilities || [];
  return Array.isArray(rows) ? rows : [];
}

export function attackPath(scenario: Scenario | undefined | null): Row[] {
  const rows = runtimeSpec(scenario).attack_path || [];
  return Array.isArray(rows) ? rows : [];
}

/** "dc01" for a single VM, "web01–web03" for a counted group, or the role with spaces. */
export function vmLabel(asset: Row | undefined, instanceRole: string | undefined = asset?.role): string {
  const code = String(asset?.vm_name || '').trim();
  if (!code) return String(instanceRole || 'Machine').replace(/_/g, ' ');
  const count = Math.max(1, Number(asset?.count || 1));
  if (count <= 1) return code;
  const match = String(instanceRole || '').match(/_(\d+)$/);
  if (match) return code + String(match[1]).padStart(2, '0');
  return `${code}01–${code}${String(count).padStart(2, '0')}`;
}

export function scenarioVmLabel(scenario: Scenario | undefined | null, role: string): string {
  const assets = (runtimeSpec(scenario).assets || []) as Row[];
  const asset = assets.find((row) => row.role === role || String(role).startsWith(`${row.role}_`));
  return asset ? vmLabel(asset, role) : String(role || 'Machine').replace(/_/g, ' ');
}

/** Network, routing and service-check lines for one attack-path step. */
export function pathSetup(scenario: Scenario | undefined | null, role: string) {
  const runtime = runtimeSpec(scenario);
  const asset = ((runtime.assets || []) as Row[]).find((row) => row.role === role);
  if (!asset) return { network: 'Asset not declared', route: '', check: '' };
  const networks = new Map(((runtime.networks || []) as Row[]).map((row) => [row.name, row]));
  const names: string[] = asset.networks || [];
  const network =
    names
      .map((name) => {
        const vlan = networks.get(name)?.vlan_id;
        return name + (vlan == null ? '' : ` · VLAN ${vlan}`);
      })
      .join(', ') || 'No network declared';
  const rules = ((runtime.routing_policy?.rules || []) as Row[]).filter((row) => names.includes(row.to));
  const route = rules.map((row) => `${row.from} → ${row.to} ${String(row.protocol || '').toUpperCase()} ${(row.ports || []).join('/')}`).join('; ');
  const probes = ((runtime.validation?.probes || []) as Row[]).filter((row) => row.role === role && ['http_status', 'tcp_connect'].includes(row.type));
  const check = probes.map((row) => `${row.type === 'http_status' ? 'HTTP' : 'TCP'} :${row.port}`).join(', ');
  return { network, route, check };
}

export function playGuide(scenario: Scenario | undefined | null): { red: string[]; blue: string[] } {
  const guide = runtimeSpec(scenario).play_guide || {};
  return { red: Array.isArray(guide.red) ? guide.red : [], blue: Array.isArray(guide.blue) ? guide.blue : [] };
}

export function sideObjectives(scenario: Scenario | undefined | null, side: 'red' | 'blue'): (string | Row)[] {
  const rows = (runtimeSpec(scenario).objectives || {})[side] || [];
  return Array.isArray(rows) ? rows : [];
}

export function winCondition(scenario: Scenario | undefined | null, side: 'red' | 'blue'): string | undefined {
  return ((runtimeSpec(scenario).win_conditions || {})[side] || [])[0];
}

export function objectiveText(value: string | Row): string {
  return typeof value === 'string' ? value : value.title || value.name || value.role || 'Objective';
}
