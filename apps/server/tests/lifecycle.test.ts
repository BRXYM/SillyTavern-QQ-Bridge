import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../src/app/lifecycle.ts';

test('startup failure rolls back the failing step and earlier steps in reverse order', async () => {
    const events: string[] = [];
    const lifecycle = new Lifecycle(['a', 'b', 'c'].map((name) => ({
        name,
        start: () => { events.push(`start:${name}`); if (name === 'b') throw new Error('occupied'); },
        stop: () => { events.push(`stop:${name}`); },
    })));
    await assert.rejects(lifecycle.start(), /occupied/);
    await lifecycle.stop();
    assert.deepEqual(events, ['start:a', 'start:b', 'stop:b', 'stop:a']);
});

test('shutdown continues after errors and concurrent stops share cleanup', async () => {
    const events: string[] = [];
    const lifecycle = new Lifecycle(['a', 'b'].map((name) => ({
        name, start: () => {},
        stop: () => { events.push(name); if (name === 'b') throw new Error('cleanup failed'); },
    })));
    await Promise.all([lifecycle.start(), lifecycle.start()]);
    const stop = lifecycle.stop();
    assert.equal(lifecycle.stop(), stop);
    await assert.rejects(stop, AggregateError);
    assert.deepEqual(events, ['b', 'a']);
});

test('stop during startup waits for the step and then releases it', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = new Lifecycle([{ name: 'a', start: async () => { await gate; events.push('started'); },
        stop: () => { events.push('stopped'); } }]);
    const start = lifecycle.start();
    const stop = lifecycle.stop();
    release();
    await Promise.all([start, stop]);
    assert.deepEqual(events, ['started', 'stopped']);
    await assert.rejects(lifecycle.start(), /应用已关闭/);
});
