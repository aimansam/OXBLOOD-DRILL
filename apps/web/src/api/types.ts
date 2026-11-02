// Shapes for endpoints that have no response_model yet. Fields are those the UI reads;
// everything else is left as `unknown` on purpose.
import type { components } from './schema';

export type Drill = components['schemas']['DrillOut'];
export type Scenario = components['schemas']['ScenarioOut'];

export interface PreflightCheck {
  ready: boolean;
  detail: string;
}
export interface ScenarioPreflight {
  ready: boolean;
  node: string;
  checks: PreflightCheck[];
}
export interface PveConfigResponse {
  node?: string;
  clone_storage?: string;
  seed_snippet_storage?: string;
  config?: { node?: string; clone_storage?: string; seed_snippet_storage?: string };
}
export interface TemplateStatus {
  ready?: boolean;
  template?: string;
  available?: string[];
  error?: string;
}
export interface TemplateList {
  items?: { name: string }[];
  templates?: { name: string }[];
  error?: string;
}
export interface BridgeSpec {
  name: string;
  cidr: string;
  scenario: string;
  network: string;
}
export interface ExpectedBridges {
  bridges?: BridgeSpec[];
  conflicts?: string[];
  error?: string;
}
export interface SdnStatus {
  reachable?: boolean;
  vnets_present?: string[];
  vnets_missing?: string[];
  present?: string[];
  missing?: string[];
  error?: string;
}
export interface StorageStatus {
  items?: { storage: string; content?: string[] }[];
  error?: string;
}
export interface ProvisionAsset {
  id?: number;
  role: string;
  status: string;
  pve_vmid?: number | null;
  ip?: string | null;
  error?: string | null;
}
export interface DrillStatus {
  environment_config?: Record<string, unknown> | null;
  lifecycle?: { provision_phase?: string } | null;
  provision?: { assets?: ProvisionAsset[] } | null;
}
