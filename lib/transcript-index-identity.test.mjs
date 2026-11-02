import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { TranscriptReader } = await jiti.import('./transcript-reader.ts');
const { createHistoryProjection, getHistoryIndex, getHistoryWindow, searchHistory } = await jiti.import('./session-history.ts');
const { compareOrderKeys, CLIENT_MESSAGE_CUSTOM_TYPE, historyEntryOrderKey } = await jiti.import('./transcript-order.ts');
const { emptyTranscript, appendPersisted, mergeTranscriptPage, newestPersistedEntryId } = await jiti.import('./transcript-store.ts');
const { clearHistoryViewCache } = await jiti.import('./session-view-cache.ts');
const node = n => ({ entryId: `q${n}`, orderKey: [n, 1, n], nodeIndex: n, messageIndex: n, kind: 'question', questionIndex: n, preview: `q${n}` });
const index = (nodes, offset, total, revision) => ({ kind: 'index', sessionId: 's', leafId: 'leaf', revision, nodes, offset, total, totalMessages: total, before: offset ? 'before' : null, after: offset + nodes.length < total ? 'after' : null });

test('full index pagination admits continuous appends across changing revisions', async () => {
  clearHistoryViewCache();
  let count = 405, calls = 0;
  const reader = new TranscriptReader({ sessionId: 's', peer: null }, async (_scope, request) => {
    calls++;
    count += 3;
    const offset = request.offset ?? 0;
    return index(Array.from({ length: Math.min(100, count - offset) }, (_, n) => node(offset + n)), offset, count, `revision-${calls}`);
  });
  await reader.loadFullIndex();
  const state = reader.getState(), nodes = state.index.pages.flatMap(page => page.nodes);
  assert.equal(state.error, null);
  assert.ok(calls >= 5);
  assert.equal(nodes.length, count);
  assert.deepEqual(nodes.map(row => row.nodeIndex), Array.from({ length: count }, (_, n) => n));
  assert.ok(nodes.every((row, n) => !n || compareOrderKeys(nodes[n - 1].orderKey, row.orderKey) < 0));
  reader.dispose();
});

test('structural insertion restarts a full index once without publishing a mixed rail', async () => {
  clearHistoryViewCache();
  let calls = 0;
  const requested = [];
  const reader = new TranscriptReader({ sessionId: 's', peer: null }, async (_scope, request) => {
    const offset = request.offset ?? 0; requested.push(offset); calls++;
    const nodes = calls === 1 ? [node(0), node(1), node(2), node(3)] : [node(0), { ...node(9), orderKey: [1, 0, 9] }, node(1), node(2), node(3)];
    const ranked = nodes.map((row, nodeIndex) => ({ ...row, nodeIndex }));
    return index(ranked.slice(offset, offset + 3), offset, ranked.length, `revision-${calls}`);
  });
  await reader.loadFullIndex();
  assert.deepEqual(requested, [0, 3, 0, 3]);
  assert.deepEqual(reader.getState().index.pages.flatMap(page => page.nodes.map(row => row.entryId)), ['q0', 'q9', 'q1', 'q2', 'q3']);
  assert.equal(reader.getState().error, null);
  reader.dispose();
});

test('client identity records are invisible to every reading surface and preserve the first question', () => {
  const stamp = '2026-10-23T00:00:00Z';
  const entries = [
    { type: 'message', id: 'q', parentId: null, timestamp: stamp, message: { role: 'user', content: 'real question' } },
    { type: 'custom', id: 'identity', parentId: 'q', timestamp: stamp, customType: CLIENT_MESSAGE_CUSTOM_TYPE, data: { entryId: 'q', clientMessageId: 'client-secret-marker' } },
    { type: 'message', id: 'a', parentId: 'identity', timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: 'real answer' }], stopReason: 'stop' } },
  ];
  const projection = createHistoryProjection(entries, { sessionId: 's' });
  const page = getHistoryWindow(projection), navigation = getHistoryIndex(projection);
  assert.deepEqual(page.items.map(row => row.entryId), ['q', 'a']);
  assert.equal(page.totalMessages, 2);
  assert.equal(page.firstUserEntryId, 'q');
  assert.equal(page.items[0].clientMessageId, 'client-secret-marker');
  assert.deepEqual(navigation.nodes.map(row => row.entryId), ['q']);
  assert.equal(searchHistory(projection, { q: 'client-secret-marker' }).total, 0);
  assert.equal(searchHistory(projection, { q: 'real' }).total, 2);
  assert.equal(page.items.filter(row => row.process).length, 0);
  assert.deepEqual(page.items[1].orderKey, historyEntryOrderKey(entries[2], 2));
});

test('an SSE row never advances the HTTP coverage cursor past unread process rows', () => {
  const body = { role: 'assistant', content: [{ type: 'text', text: 'latest' }] };
  const state = appendPersisted(emptyTranscript(), body, 'latest', { orderKey: [100, 1, 100] });
  assert.equal(newestPersistedEntryId(state), null);
  const page = { kind: 'window', sessionId: 's', leafId: 'latest', revision: 'r', items: [{ entryId: 'q', orderKey: [0, 1, 0], role: 'user', sourceType: 'message', messageIndex: 0, turnAnchor: null, message: { role: 'user', content: 'question' }, contentState: 'full', process: false, toolCallCount: 0, deferred: [] }], nodeCount: 1, nodeOffset: 0, totalMessages: 101, firstUserEntryId: 'q', before: null, after: null, coverage: { start: true, end: true } };
  const merged = mergeTranscriptPage(state, page, 'append');
  assert.deepEqual(merged.entryIds, ['q', 'latest']);
  assert.equal(newestPersistedEntryId(merged), 'q');
});
