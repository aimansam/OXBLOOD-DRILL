export type Asset = {
  id: number;
  role: string;
  kind?: string | null;
  status?: string | null;
  ip?: string | null;
  networks?: string[] | null;
  error?: string | null;
  console_available?: boolean;
  console_message?: string | null;
};

export type Network = {
  name: string;
  cidr?: string | null;
  vlan_id?: number | string | null;
};

export type ThreatMap = {
  drill_id: number;
  status: string;
  role: string;
  provision_status?: string | null;
  networks: Network[];
  assets: Asset[];
  scenario?: { title?: string | null; name?: string | null } | null;
};

export type Drill = {
  id: number;
  title?: string | null;
  status?: string | null;
};
