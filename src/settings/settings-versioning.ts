/**
 * Pure helpers for versioned settings (unit tested in settings-versioning.spec.ts).
 */
export type SettingsRecord = Record<string, unknown>;

export interface VersionLike {
  version: number;
  effectiveFrom: Date;
  changes: SettingsRecord;
  appliedAt: Date | null;
  cancelledAt: Date | null;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The entries of `patch` that actually change `current` (undefined = not sent). */
export function diffSettings(
  current: object,
  patch: object,
): { changes: SettingsRecord; changedKeys: string[] } {
  const changes: SettingsRecord = {};
  const before = current as SettingsRecord;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && !same(before[key], value)) {
      changes[key] = value;
    }
  }
  return { changes, changedKeys: Object.keys(changes).sort() };
}

export function applyChanges<T extends object>(
  settings: T,
  changes: SettingsRecord,
): T {
  return { ...settings, ...changes };
}

const byEffectiveOrder = (a: VersionLike, b: VersionLike) =>
  a.effectiveFrom.getTime() - b.effectiveFrom.getTime() ||
  a.version - b.version;

/** Scheduled (not applied, not cancelled) versions that are due at `now`, in apply order. */
export function dueVersions<V extends VersionLike>(
  versions: V[],
  now: Date,
): V[] {
  return versions
    .filter(
      (v) =>
        !v.appliedAt &&
        !v.cancelledAt &&
        v.effectiveFrom.getTime() <= now.getTime(),
    )
    .sort(byEffectiveOrder);
}

/** When the next scheduled change takes effect (null when none is waiting). */
export function nextScheduledAt(
  versions: VersionLike[],
  now: Date,
): Date | null {
  const upcoming = versions
    .filter(
      (v) =>
        !v.appliedAt &&
        !v.cancelledAt &&
        v.effectiveFrom.getTime() > now.getTime(),
    )
    .sort(byEffectiveOrder);
  return upcoming[0]?.effectiveFrom ?? null;
}

/**
 * Effective settings at `at`: the stored (applied) settings plus every scheduled
 * change due by then, applied in effective-date order. Later changes win per key;
 * keys a change doesn't touch keep their current value.
 */
export function resolveEffective<T extends object>(
  applied: T,
  versions: VersionLike[],
  at: Date,
): T {
  return dueVersions(versions, at).reduce<T>(
    (settings, v) => applyChanges(settings, v.changes),
    applied,
  );
}

export type VersionStatus = 'applied' | 'scheduled' | 'cancelled';

export function versionStatus(v: VersionLike): VersionStatus {
  if (v.cancelledAt) return 'cancelled';
  return v.appliedAt ? 'applied' : 'scheduled';
}
