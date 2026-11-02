import type {
  ExpectedBridges,
  PveConfigResponse,
  Scenario,
  ScenarioPreflight,
  SdnStatus,
  StorageStatus,
  TemplateList,
  TemplateStatus,
} from '@/api/types';
import { networkRefs, templateRefs } from '../scenarios/helpers';

export interface ReadinessInputs {
  scenario: Scenario;
  pve: PveConfigResponse;
  templateStatus: TemplateStatus;
  pveTemplates: TemplateList;
  bridgePlan: ExpectedBridges;
  bridgeStatus: SdnStatus;
  storageStatus: StorageStatus;
  preflight: ScenarioPreflight;
}

export interface Readiness {
  node: string;
  cloneStorage: string;
  snippetStorage: string;
  preflightChecks: { detail: string; ready: boolean }[];
  templateRows: { name: string; ready: boolean }[];
  networkRows: { name: string; cidr: string; bridge: string; ready: boolean }[];
  conflicts: string[];
  errors: string[];
  /** Proxmox itself is unreachable/unconfigured: every check failed for one reason. */
  infraDown: boolean;
  startable: boolean;
}

const INFRA_DOWN = /not configured|not set|503|unavailable|unreachable|timed out/i;

/**
 * Port of the classic wizard's `updateDrillScenarioReadiness` (ui-create-wizard.js), as a pure
 * function. Snippet storage is informational only: seeding uses the guest agent.
 */
export function computeReadiness(i: ReadinessInputs): Readiness {
  const node = i.pve.node || i.pve.config?.node || 'pve';
  const cloneStorage = i.pve.clone_storage || i.pve.config?.clone_storage || 'local-lvm';
  const snippetStorage = i.pve.seed_snippet_storage || i.pve.config?.seed_snippet_storage || 'local';

  const refs = templateRefs(i.scenario);
  const required = refs.length ? refs : [i.templateStatus.template || 'tpl-debian-cloudinit'];
  const listed = new Set((i.pveTemplates.items ?? i.pveTemplates.templates ?? []).map((t) => t?.name).filter(Boolean));
  for (const name of i.templateStatus.available ?? []) if (name) listed.add(name);
  if (i.templateStatus.ready && i.templateStatus.template) listed.add(i.templateStatus.template);
  const templateRows = required.map((name) => ({ name, ready: listed.has(name) }));

  const bridges = i.bridgePlan.bridges ?? [];
  const scenarioName = (i.scenario.name as string) || '';
  const planned = new Map(bridges.filter((b) => b && b.scenario === scenarioName).map((b) => [b.network, b]));
  // VLAN scenarios share one bridge, reported as shared / vlan-aware.
  const sharedVlan = bridges.find((b) => b && b.network === 'vlan-aware' && b.name);
  const present = new Set(i.bridgeStatus.vnets_present ?? i.bridgeStatus.present ?? []);
  const missing = new Set(i.bridgeStatus.vnets_missing ?? i.bridgeStatus.missing ?? []);
  const networkRows = networkRefs(i.scenario).map((n) => {
    const plan = planned.get(n.name) ?? (n.vlan_id != null ? sharedVlan : undefined);
    const bridge = plan?.name ?? '';
    return {
      name: n.name,
      cidr: n.cidr || plan?.cidr || '',
      bridge,
      ready: bridge ? present.has(bridge) && !missing.has(bridge) : false,
    };
  });

  const conflicts = i.bridgePlan.conflicts ?? [];
  const templatesReady = templateRows.every((r) => r.ready);
  const networksReady = networkRows.length ? networkRows.every((r) => r.ready) && i.bridgeStatus.reachable !== false : true;
  const storageReachable = !i.storageStatus.error;
  const errors = [i.templateStatus.error, i.pveTemplates.error, i.bridgeStatus.error, i.storageStatus.error].filter(Boolean) as string[];
  const infraDown = errors.length >= 2 && errors.every((m) => INFRA_DOWN.test(String(m)));
  const startable = i.preflight.ready && templatesReady && networksReady && storageReachable && conflicts.length === 0;

  return {
    node,
    cloneStorage,
    snippetStorage,
    preflightChecks: i.preflight.checks ?? [],
    templateRows,
    networkRows,
    conflicts,
    errors,
    infraDown,
    startable,
  };
}

/** Largest roster the API accepts (apps/api drill_service.MAX_PARTICIPANTS). */
export const MAX_PARTICIPANTS = 20;

/** Wizard field rules. */
export function validateDetails(fields: { title: string; maxParticipants: string; duration: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!fields.title.trim()) errors.title = 'Title is required';
  const max = Number(fields.maxParticipants);
  if (fields.maxParticipants && (!Number.isInteger(max) || max < 1 || max > MAX_PARTICIPANTS)) errors.maxParticipants = `Enter 1 to ${MAX_PARTICIPANTS} participants`;
  const duration = Number(fields.duration);
  if (fields.duration && (!Number.isInteger(duration) || duration < 1)) errors.duration = 'Enter a duration in minutes';
  return errors;
}
