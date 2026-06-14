import { describe, it, before } from 'mocha';
import assert from 'assert';
import { instrumentFetch, runWithRequestAttribution } from '../../scripts/request-metrics.js';

describe('per-account request attribution', function () {
    before(() => {
        // Stub fetch BEFORE instrumenting so the wrapper counts our calls without
        // making real network requests.
        globalThis.fetch = (async () => ({ ok: true } as any)) as any;
        instrumentFetch();
    });

    it('attributes requests made within a context to that context, by host', async () => {
        const { byHost } = await runWithRequestAttribution(async () => {
            await fetch('https://archival-rpc.mainnet.fastnear.com/');
            await fetch('https://archival-rpc.mainnet.fastnear.com/');
            await fetch('https://tx.main.fastnear.com/v0/account/x');
        });
        assert.equal(byHost['archival-rpc.mainnet.fastnear.com'], 2);
        assert.equal(byHost['tx.main.fastnear.com'], 1);
    });

    it('does not mix concurrent contexts (AsyncLocalStorage isolation)', async () => {
        const a = runWithRequestAttribution(async () => {
            await fetch('https://transfers.main.fastnear.com/a');
            await new Promise((r) => setTimeout(r, 20)); // yield so b interleaves
            await fetch('https://transfers.main.fastnear.com/a');
        });
        const b = runWithRequestAttribution(async () => {
            await fetch('https://archival-rpc.mainnet.fastnear.com/b');
        });
        const [ra, rb] = await Promise.all([a, b]);

        assert.equal(ra.byHost['transfers.main.fastnear.com'], 2);
        assert.equal(ra.byHost['archival-rpc.mainnet.fastnear.com'], undefined);
        assert.equal(rb.byHost['archival-rpc.mainnet.fastnear.com'], 1);
        assert.equal(rb.byHost['transfers.main.fastnear.com'], undefined);
    });

    it('does not throw for fetches outside any attribution context', async () => {
        await fetch('https://archival-rpc.mainnet.fastnear.com/');
    });
});
