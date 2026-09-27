// Kill switch: ON if the env var KILL_SWITCH=true OR the database flag is set (CLI: rat kill / rat resume).
// Checked by the GuardedSender before every transaction.
import { type KillSwitch, SETTINGS, type SettingsStore } from '@rat/core';

export class DbKillSwitch implements KillSwitch {
  constructor(
    private readonly settings: SettingsStore,
    private readonly envKill: boolean,
  ) {}

  async status(): Promise<{ on: boolean; reason: string | null }> {
    if (this.envKill) return { on: true, reason: 'KILL_SWITCH env var is true' };
    const v = await this.settings.get(SETTINGS.killSwitch);
    if (v === 'on') return { on: true, reason: (await this.settings.get(SETTINGS.killReason)) ?? 'killed from the database' };
    return { on: false, reason: null };
  }
}

export async function engageKillSwitch(settings: SettingsStore, reason: string): Promise<void> {
  await settings.set(SETTINGS.killReason, reason);
  await settings.set(SETTINGS.killSwitch, 'on');
}

export async function releaseKillSwitch(settings: SettingsStore): Promise<void> {
  await settings.set(SETTINGS.killSwitch, 'off');
}
