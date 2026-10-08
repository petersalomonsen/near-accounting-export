// When each account was last synced, kept on disk.
//
// The worker defers a complete account for eight hours between syncs. That
// clock used to live in memory, so every restart — every deploy — forgot it
// and treated all accounts as due at once: a full cycle of some 1 600
// requests, most of them archival RPC, for nothing new. Written to the data
// directory beside accounts.json, the clock survives a restart and the
// schedule simply resumes.

import fs from 'fs';

export interface SyncClock {
    get(accountId: string): number | undefined;
    set(accountId: string, ms: number): void;
    /** Accounts with a remembered sync time. */
    size: number;
}

export function loadSyncClock(file: string): Map<string, number> {
    if (!fs.existsSync(file)) return new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const entries = Object.entries(parsed?.lastSyncMs ?? {})
            .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]));
        return new Map(entries);
    } catch {
        // An unreadable clock costs one full cycle, the same as before it existed.
        return new Map();
    }
}

export function saveSyncClock(file: string, clock: Map<string, number>): void {
    const lastSyncMs = Object.fromEntries([...clock.entries()].sort());
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastSyncMs }, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * A Map-shaped clock that writes through to `file` on every set, so the
 * last sync time is on disk before the next account starts.
 */
export function openSyncClock(file: string): SyncClock {
    const clock = loadSyncClock(file);
    return {
        get: id => clock.get(id),
        set: (id, ms) => { clock.set(id, ms); saveSyncClock(file, clock); },
        get size() { return clock.size; },
    };
}
