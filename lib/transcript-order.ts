import type { SessionEntry } from './types';
import type { HistoryOrderKey } from './session-history-types';

export function historyEntryOrderKey(entry: SessionEntry, appendOrdinal: number, firstKeptOrdinal?: number): HistoryOrderKey {
  return entry.type === 'compaction' && firstKeptOrdinal !== undefined
    ? [firstKeptOrdinal, 0, appendOrdinal] : [appendOrdinal, 1, appendOrdinal];
}

/** Physical append ordinals remain stable when the display timeline gains a compaction card. */
export function historyOrderKeys(entries: readonly SessionEntry[]): Map<string, HistoryOrderKey> {
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  return new Map(entries.map((entry, index) => [entry.id, historyEntryOrderKey(entry, index,
    entry.type === 'compaction' ? positions.get(entry.firstKeptEntryId) : undefined)]));
}

export function isHistoryOrderKey(value: unknown): value is HistoryOrderKey {
  return Array.isArray(value) && value.length === 3 && value.every(part => Number.isSafeInteger(part) && part >= 0) && value[1] <= 1;
}

export function compareOrderKeys(left: HistoryOrderKey, right: HistoryOrderKey): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export const CLIENT_MESSAGE_CUSTOM_TYPE = 'pi-web:client-message';
export function historyClientMessageIds(entries: readonly SessionEntry[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== CLIENT_MESSAGE_CUSTOM_TYPE) continue;
    const data = entry.data as { entryId?: unknown; clientMessageId?: unknown } | undefined;
    if (typeof data?.entryId === 'string' && typeof data.clientMessageId === 'string') ids.set(data.entryId, data.clientMessageId);
  }
  return ids;
}
