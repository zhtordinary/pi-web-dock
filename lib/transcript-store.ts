import type { AgentMessage } from './types';
import type { HistoryOrderKey, HistoryWindowItem, HistoryWindowPage } from './session-history-types';
import { compareOrderKeys } from './transcript-order.ts';

const OCCURRENCE = '__readerTranscriptOccurrenceId';
const CLIENT_ID = '__readerClientMessageId';
const PLACEHOLDER = '__readerPlaceholder';
type DisplayMessage = AgentMessage & { [OCCURRENCE]?: string; [CLIENT_ID]?: string; [PLACEHOLDER]?: boolean };
export interface TranscriptMessages { messages: AgentMessage[]; entryIds: string[] }
export function occurrenceId(message: AgentMessage): string | undefined { return (message as DisplayMessage)[OCCURRENCE]; }
export function clientMessageId(message: AgentMessage): string | undefined { return (message as DisplayMessage)[CLIENT_ID]; }
export function isTranscriptPlaceholder(message: AgentMessage): boolean { return (message as DisplayMessage)[PLACEHOLDER] === true; }
export function withOccurrence<T extends AgentMessage>(message: T, id = crypto.randomUUID(), clientId?: string): T {
  return { ...message, [OCCURRENCE]: id, ...(clientId ? { [CLIENT_ID]: clientId } : {}) };
}
export function upsertMessage<T extends TranscriptMessages>(current: T, message: AgentMessage, entryId = ''): T {
  const clientId = clientMessageId(message);
  const occurrence = occurrenceId(message);
  let index = entryId ? current.entryIds.indexOf(entryId) : -1;
  if (index < 0 && clientId) index = current.messages.findIndex(item => clientMessageId(item) === clientId);
  if (index < 0 && occurrence) index = current.messages.findIndex(item => occurrenceId(item) === occurrence);
  const messages = [...current.messages], entryIds = [...current.entryIds];
  if (index < 0) { messages.push(occurrence || entryId ? message : withOccurrence(message)); entryIds.push(entryId); index = messages.length - 1; }
  else {
    const retained = occurrenceId(messages[index]) ?? occurrence;
    messages[index] = retained ? withOccurrence(message, retained, clientId ?? clientMessageId(messages[index])) : message;
    if (entryId) entryIds[index] = entryId;
  }
  if (clientId && entryId) for (let i = messages.length - 1; i >= 0; i--) {
    if (i !== index && !entryIds[i] && clientMessageId(messages[i]) === clientId) { messages.splice(i, 1); entryIds.splice(i, 1); }
  }
  return { ...current, messages, entryIds };
}
export function removeMessage<T extends TranscriptMessages>(current: T, previous: AgentMessage): T {
  const id = occurrenceId(previous);
  const index = id ? current.messages.findIndex(item => occurrenceId(item) === id) : current.messages.indexOf(previous);
  if (index < 0) return current;
  return { ...current, messages: current.messages.filter((_, i) => i !== index), entryIds: current.entryIds.filter((_, i) => i !== index) };
}
export interface Transcript extends TranscriptMessages {
  items: Map<string, HistoryWindowItem>;
  before: string | null;
  after: string | null;
  loaded: boolean;
  firstUserEntryId: string | null;
  nodeCount: number;
  historyCursor: string | null;
}
export function emptyTranscript(): Transcript {
  return { messages: [], entryIds: [], items: new Map(), before: null, after: null, loaded: false, firstUserEntryId: null, nodeCount: 0, historyCursor: null };
}
function ordered(state: Transcript): Transcript {
  const rows = state.messages.map((message, index) => ({ message, entryId: state.entryIds[index], orderKey: state.items.get(state.entryIds[index])?.orderKey }));
  rows.sort((a, b) => a.orderKey && b.orderKey ? compareOrderKeys(a.orderKey, b.orderKey) : a.orderKey ? -1 : b.orderKey ? 1 : 0);
  return { ...state, messages: rows.map(row => row.message), entryIds: rows.map(row => row.entryId) };
}
function displayMessage(item: HistoryWindowItem): AgentMessage {
  const body = item.message ?? ({ role: item.role, content: [], toolCallId: '', command: '', output: '', customType: '', [PLACEHOLDER]: true } as DisplayMessage);
  return item.clientMessageId ? withOccurrence(body, item.entryId, item.clientMessageId) : body;
}
export interface TranscriptDelivery { orderKey?: HistoryOrderKey; clientMessageId?: string }
export function appendPersisted(state: Transcript, message: AgentMessage, entryId = '', delivery: TranscriptDelivery = {}): Transcript {
  if (state.after !== null) return state;
  const current = upsertMessage(state, delivery.clientMessageId ? withOccurrence(message, occurrenceId(message), delivery.clientMessageId) : message, entryId);
  if (!entryId || !delivery.orderKey) return current;
  const items = new Map(current.items);
  const blocks = 'content' in message && Array.isArray(message.content) ? message.content : [];
  items.set(entryId, { ...items.get(entryId), entryId, orderKey: delivery.orderKey, clientMessageId: delivery.clientMessageId,
    role: message.role, message, sourceType: 'message', turnAnchor: items.get(entryId)?.turnAnchor ?? null, contentState: 'full', deferred: [],
    process: message.role === 'toolResult' || message.role === 'bashExecution' || blocks.some(block => block.type !== 'text' && block.type !== 'image'),
    toolCallCount: blocks.filter(block => block.type === 'toolCall').length });
  return ordered({ ...current, items });
}
/** Only HTTP coverage advances the read cursor; an SSE delivery cannot prove a gap was read. */
export function newestPersistedEntryId(state: Transcript): string | null { return state.historyCursor; }
export function mergeTranscriptPage(current: Transcript, page: HistoryWindowPage, operation: 'reset' | 'prepend' | 'append' | 'expand' | 'reconcile'): Transcript {
  const state = operation === 'reset' ? emptyTranscript() : current;
  const items = new Map(state.items);
  let next: Transcript = { ...state, items };
  const rank = { placeholder: 0, answer: 1, full: 2 };
  for (const item of page.items) {
    const previous = items.get(item.entryId);
    const keepBody = previous && rank[previous.contentState] > rank[item.contentState];
    const merged = keepBody ? { ...item, message: previous.message, contentState: previous.contentState, deferred: previous.deferred } : item;
    if (previous && JSON.stringify(previous) === JSON.stringify(merged)) continue;
    items.set(item.entryId, merged);
    next = upsertMessage(next, displayMessage(merged), item.entryId);
  }
  const metadata = { loaded: true,
    before: state.loaded && (operation === 'append' || operation === 'expand' || operation === 'reconcile') ? state.before : page.before,
    after: operation === 'prepend' || operation === 'expand' || operation === 'reconcile' ? state.after : page.after,
    firstUserEntryId: page.firstUserEntryId, nodeCount: page.nodeCount,
    historyCursor: operation === 'expand' || operation === 'prepend' ? state.historyCursor : page.items.at(-1)?.entryId ?? state.historyCursor };
  if (next.messages === current.messages && Object.entries(metadata).every(([key, value]) => current[key as keyof Transcript] === value)) return current;
  const result = { ...next, ...metadata, items: next.messages === state.messages ? state.items : items };
  return next.messages === state.messages ? result : ordered(result);
}
export interface TranscriptView extends TranscriptMessages { messageIndexByEntryId: Map<string, number> }
export function transcriptView(state: Transcript): TranscriptView {
  return { messages: state.messages, entryIds: state.entryIds, messageIndexByEntryId: new Map(state.entryIds.map((id, index) => [id, index])) };
}
