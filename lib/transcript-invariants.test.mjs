import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { emptyTranscript, appendPersisted, mergeTranscriptPage } = await jiti.import('./transcript-store.ts');
const { createHistoryProjection, getHistoryWindow } = await jiti.import('./session-history.ts');
const message = (role, text) => ({ role, timestamp: 1, content: role === 'user' ? text : [{ type: 'text', text }] });
const item = (id, order, body = message('assistant', id), extra = {}) => ({ entryId: id, orderKey: [order, 1, order], role: body?.role ?? 'assistant', sourceType: 'message', messageIndex: order, turnAnchor: null, message: body, process: false, toolCallCount: 0, deferred: [], ...extra });
// Also accepted by the unmodified reader, so the red run reaches the disputed join/sort.
const page = (items, extra = {}) => ({ kind: 'window', sessionId: 's', leafId: 'leaf', revision: 'r', items, processSummaries: [], before: null, after: null, coverage: { start: true, end: true }, totalMessages: 100, firstUserEntryId: 'q', lastUserEntryId: 'q', nodeCount: 1, nodeOffset: 0, ...extra });

test('an SSE row covered by folded history stays before the final answer', () => {
  let state = mergeTranscriptPage(emptyTranscript(), page([item('q', 0, message('user', 'question'))]), 'reset');
  state = appendPersisted(state, message('assistant', 'early process'), 'early', { orderKey: [1, 1, 1] });
  state = mergeTranscriptPage(state, page([item('q', 0, message('user', 'question')), item('answer', 2)]), 'append');
  assert.deepEqual(state.entryIds, ['q', 'early', 'answer']);
});

test('a two-image optimistic prompt joins its URL history row by clientMessageId', () => {
  const inline = { role: 'user', content: [{ type: 'text', text: 'same image prompt' }, ...[1, 2].map(n => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `image-${n}` } }))] };
  const linked = { ...inline, content: [{ type: 'text', text: 'same image prompt' }, ...[1, 2].map(n => ({ type: 'image', source: { type: 'url', media_type: 'image/png', url: `/images/${n}` } }))] };
  let state = appendPersisted(emptyTranscript(), inline, '', { clientMessageId: 'client-image' });
  state = mergeTranscriptPage(state, page([item('persisted', 1, linked, { clientMessageId: 'client-image' })]), 'append');
  assert.deepEqual(state.entryIds, ['persisted']);
  assert.equal(state.messages.length, 1);
  state = appendPersisted(state, inline, 'persisted', { orderKey: [1, 1, 1], clientMessageId: 'client-image' });
  assert.equal(state.messages.length, 1);
});

test('folded transport contains one identity/order placeholder per process row', () => {
  const entries = [
    { type: 'message', id: 'q', parentId: null, timestamp: '2026-10-23T00:00:00Z', message: message('user', 'question') },
    { type: 'message', id: 'p', parentId: 'q', timestamp: '2026-10-23T00:00:01Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private process body' }, { type: 'toolCall', id: 'call', name: 'bash', arguments: {} }], stopReason: 'toolUse' } },
    { type: 'message', id: 't', parentId: 'p', timestamp: '2026-10-23T00:00:02Z', message: { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'private tool body' }] } },
    { type: 'message', id: 'a', parentId: 't', timestamp: '2026-10-23T00:00:03Z', message: message('assistant', 'answer') },
  ];
  const result = getHistoryWindow(createHistoryProjection(entries, { sessionId: 's' }));
  assert.deepEqual(result.items.map(row => row.entryId), ['q', 'p', 't', 'a']);
  assert.equal(Object.hasOwn(result, 'processSummaries'), false);
  for (const id of ['p', 't']) {
    const row = result.items.find(row => row.entryId === id);
    assert.equal(row.message, null);
    assert.ok(Array.isArray(row.orderKey));
    assert.ok(row.role);
  }
  assert.doesNotMatch(JSON.stringify(result), /private process body|private tool body/);
  assert.equal(result.items.filter(row => row.process).length, 2);
});

test('seeded interleavings preserve order, identity and the per-turn row count', () => {
  for (let seed = 1; seed <= 24; seed++) {
    let random = seed;
    const next = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
    let state = emptyTranscript();
    const expected = new Map();
    for (let step = 0; step < 80; step++) {
      const n = next(20), id = `e${n}`, operation = ['reset', 'prepend', 'append', 'reconcile', 'expand'][next(5)];
      const row = item(id, n, message(n % 5 === 0 ? 'user' : 'assistant', id), { clientMessageId: n % 5 === 0 ? `client-${n}` : undefined });
      if (step > 0 && next(3) === 0) {
        state = appendPersisted(state, row.message, id, { orderKey: row.orderKey, clientMessageId: row.clientMessageId });
      } else {
        if (operation === 'reset') expected.clear();
        state = mergeTranscriptPage(state, page([row]), operation);
      }
      expected.set(id, row);
      const ordered = [...expected.values()].sort((a, b) => a.orderKey[0] - b.orderKey[0]);
      assert.deepEqual(state.entryIds, ordered.map(row => row.entryId), `seed=${seed} step=${step}`);
      assert.equal(new Set(state.entryIds).size, state.entryIds.length);
      const turns = state.messages.reduce((groups, msg) => { if (msg.role === 'user' || groups.length === 0) groups.push([]); groups.at(-1).push(msg); return groups; }, []);
      assert.equal(turns.reduce((count, turn) => count + turn.length, 0), ordered.length);
    }
    const compact = item(`c-${seed}`, 0, { role: 'custom', customType: 'compaction', content: 'summary', display: true }, { orderKey: [10, 0, 30], sourceType: 'compaction' });
    state = mergeTranscriptPage(state, page([compact]), 'append');
    expected.set(compact.entryId, compact);
    const compare = (a, b) => a.orderKey[0] - b.orderKey[0] || a.orderKey[1] - b.orderKey[1] || a.orderKey[2] - b.orderKey[2];
    assert.deepEqual(state.entryIds, [...expected.values()].sort(compare).map(row => row.entryId));
  }
});
