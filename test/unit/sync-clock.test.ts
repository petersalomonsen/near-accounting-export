import { describe, it } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openSyncClock, loadSyncClock } from '../../scripts/sync-clock.js';

describe('sync clock', function () {
    const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clock-')), 'sync-clock.json');

    it('starts empty when there is no file', () => {
        const clock = openSyncClock(tmp());
        assert.equal(clock.get('a.near'), undefined);
        assert.equal(clock.size, 0);
    });

    it('survives a restart: what one worker set, the next one reads', () => {
        const file = tmp();
        const first = openSyncClock(file);
        first.set('a.near', 1_000);
        first.set('b.near', 2_000);
        // A new worker on the same data directory.
        const second = openSyncClock(file);
        assert.equal(second.get('a.near'), 1_000);
        assert.equal(second.get('b.near'), 2_000);
        assert.equal(second.size, 2);
    });

    it('is written through on every set, not on shutdown', () => {
        const file = tmp();
        const clock = openSyncClock(file);
        clock.set('a.near', 5);
        assert.deepEqual(loadSyncClock(file).get('a.near'), 5);
        assert.ok(!fs.existsSync(file + '.tmp'), 'no temp file left behind');
    });

    it('treats an unreadable file as empty rather than failing to start', () => {
        const file = tmp();
        fs.writeFileSync(file, '{not json');
        assert.equal(openSyncClock(file).size, 0);
        fs.writeFileSync(file, JSON.stringify({ lastSyncMs: { 'a.near': 'soon', 'b.near': 7 } }));
        const clock = openSyncClock(file);
        assert.equal(clock.get('a.near'), undefined, 'a non-number is ignored');
        assert.equal(clock.get('b.near'), 7);
    });
});
