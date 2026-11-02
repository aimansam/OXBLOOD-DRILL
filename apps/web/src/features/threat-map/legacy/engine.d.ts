export interface ThreatMapHost {
  user: { sub: string; role: string };
  toast: (message: string, type?: string) => void;
  navigate: (path: string) => void;
  openConsole: (drillId: number, assetId: number) => void | Promise<void>;
  onDrillState?: (drill: unknown) => void;
}

export class ThreatMapEngine {
  constructor(host: ThreatMapHost);
  currentDrill: unknown;
  currentDrillId: number | null;
  _threatClockInterval?: ReturnType<typeof setInterval>;
  _threatStoryTimer?: ReturnType<typeof setInterval>;
  _threatCameraFrames?: Record<string, number>;
  renderThreatMap(drill: unknown): Promise<void>;
  refreshThreatMap(): Promise<void>;
  stopThreatStoryReplay?: () => void;
  toggleThreatHudMetrics(button: HTMLElement): void;
  [method: string]: unknown;
}
