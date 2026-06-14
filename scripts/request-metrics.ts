// Lightweight outbound-request metrics. Wraps global fetch to count requests by
// host so we can see, per sync cycle, where the worker's external traffic goes
// (FastNear RPC vs tx API vs transfers API, neardata, indexers). Diagnostic only.
//
// It also supports per-account attribution via AsyncLocalStorage: wrap a unit of
// work in `runWithRequestAttribution` and every fetch made inside it (including
// awaited async work) is counted into that call's own per-host tally. This is
// correct even if multiple accounts sync concurrently, because each fetch reads
// the async-context store rather than a shared global. This is pure observability
// — no billing semantics live here.

import { AsyncLocalStorage } from 'node:async_hooks';

const counts = new Map<string, number>();
let patched = false;

interface AttributionContext {
    byHost: Record<string, number>;
}
const attribution = new AsyncLocalStorage<AttributionContext>();

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
            const ctx = attribution.getStore();
            if (ctx) ctx.byHost[host] = (ctx.byHost[host] || 0) + 1;
        } catch {
            // ignore unparseable inputs
        }
        return orig(input, init);
    }) as typeof fetch;
}

/**
 * Run `fn` inside an attribution context and return its result together with the
 * per-host count of outbound requests made during it (attributed via
 * AsyncLocalStorage, so concurrent work for other accounts is not mixed in).
 */
export async function runWithRequestAttribution<T>(
    fn: () => Promise<T>
): Promise<{ result: T; byHost: Record<string, number> }> {
    const ctx: AttributionContext = { byHost: {} };
    const result = await attribution.run(ctx, fn);
    return { result, byHost: ctx.byHost };
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
