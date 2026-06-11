// Lightweight outbound-request metrics. Wraps global fetch to count requests by
// host so we can see, per sync cycle, where the worker's external traffic goes
// (FastNear RPC vs tx API vs transfers API, neardata, indexers). Diagnostic only.

const counts = new Map<string, number>();
let patched = false;

/** Monkey-patch global fetch once to count requests by host. Idempotent. */
export function instrumentFetch(): void {
    if (patched) return;
    patched = true;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        try {
            const url = typeof input === 'string' ? input : (input?.url ?? String(input));
            const host = new URL(url).host;
            counts.set(host, (counts.get(host) || 0) + 1);
        } catch {
            // ignore unparseable inputs
        }
        return orig(input, init);
    }) as typeof fetch;
}

/** Return the per-host counts since the last reset and clear them. */
export function snapshotAndReset(): Record<string, number> {
    const out = Object.fromEntries(counts);
    counts.clear();
    return out;
}

/** Compact one-line summary, largest hosts first. */
export function formatCounts(c: Record<string, number>): string {
    const entries = Object.entries(c).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    if (total === 0) return 'requests: 0';
    return `requests: ${total} | ` + entries.map(([h, n]) => `${h}=${n}`).join(' ');
}
