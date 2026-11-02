"use client";
/* eslint-disable @next/next/no-img-element -- Recovery previews display original embedded bytes without a proxy. */
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { QueueRecoveryView } from "@/hooks/useQueueRecovery";

export function QueueRecoveryPanel({ recovery }: { recovery: QueueRecoveryView }) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const { client, entries, busy, loading, error, notice, copy, warnings = [] } = recovery;
  // Completion notices are not unresolved work. Once the last copy is saved,
  // return the composer space; real corruption/read errors remain visible.
  if (!client || (!entries.length && !error && !warnings.length && !copy && !busy)) return null;
  return <section aria-label={t("chat.queueRecoveryTitle")} tabIndex={0} style={{ marginBottom: 8, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12, boxSizing: "border-box", maxHeight: "min(320px, 35dvh)", overflowY: "auto", overscrollBehavior: "contain" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
      <strong>{t("chat.queueRecoveryTitle")} {entries.length > 0 ? `(${entries.length})` : ""}</strong>
      <button type="button" disabled={loading || Boolean(busy)} onClick={() => void client.refresh({ interactive: true })}>{loading ? t("chat.queueRecoveryLoading") : t("chat.queueRecoveryRefresh")}</button>
    </div>
    {error && <p role="alert" style={{ color: "var(--danger, #b91c1c)" }}>{error}</p>}
    {warnings.map(warning => <p key={warning} role="alert" style={{ color: "var(--danger, #b91c1c)" }}>{warning}</p>)}
    {notice && <p role="status">{t(`chat.queueRecoveryNotice_${notice}`)}</p>}
    {!entries.length && !loading && !error && !warnings.length && <span style={{ color: "var(--text-dim)" }}>{t("chat.queueRecoveryEmpty")}</span>}
    {entries.map(entry => {
      const items = [...entry.queue.steering, ...entry.queue.followUp];
      const images = items.reduce((sum, item) => sum + item.imageCount, 0);
      const pending = busy?.operationId === entry.operationId;
      return <article key={entry.operationId} style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
        <div><strong>{t(entry.status === "prepared" ? "chat.queueRecoveryUnknown" : "chat.queueRecoveryReady")}</strong> · {t("chat.queueRecoveryCounts", { count: items.length, images })}</div>
        <p style={{ margin: "4px 0", color: "var(--text-dim)" }}>{t(entry.status === "prepared" ? "chat.queueRecoveryUnknownHelp" : "chat.queueRecoveryReadyHelp")}</p>
        {images > 10 && <p>{t("chat.queueTooManyImages")}</p>}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" disabled={Boolean(busy)} onClick={() => void client.inspect(entry.operationId)}>{t("chat.queueRecoveryInspect")}</button>
          {entry.status === "committed" && <button type="button" disabled={Boolean(busy) || images > 10} onClick={() => void client.restore(entry.operationId)}>{t(client.hasDurableDraft(entry.operationId) ? "chat.queueConfirmRetry" : "chat.queueRecoveryRestore")}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void client.exportCopy(entry.operationId)}>{t("chat.queueRecoveryDownload")}</button>
        </div>
        {pending && <p role="status">{t(`chat.queueRecoveryBusy_${busy.action}`)}</p>}
        <label style={{ display: "block", margin: "8px 0 4px" }}><input type="checkbox" checked={confirmed[entry.operationId] ?? false} disabled={Boolean(busy)} onChange={event => setConfirmed(previous => ({ ...previous, [entry.operationId]: event.target.checked }))} /> {t("chat.queueRecoverySavedCheck")}</label>
        <button type="button" disabled={Boolean(busy) || !confirmed[entry.operationId]} onClick={() => void client.confirmSaved(entry, confirmed[entry.operationId] === true)}>{t("chat.queueRecoveryConfirm")}</button>
      </article>;
    })}
    {copy && <div role="region" aria-label={t("chat.queueRecoveryInspect")} style={{ marginTop: 10, maxHeight: 360, overflow: "auto", borderTop: "1px solid var(--border)" }}>
      <button type="button" onClick={() => client.closeCopy()}>{t("chat.queueRecoveryClose")}</button>
      {[...copy.queue.steering, ...copy.queue.followUp].map(item => <div key={item.itemId} style={{ marginBottom: 10 }}>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>{item.text}</pre>
        {(item.images ?? []).map((image, index) => <img key={index} alt={t("chat.queueRecoveryAttachment", { count: index + 1 })} src={`data:${image.mimeType};base64,${image.data}`} style={{ display: "block", maxWidth: "100%", maxHeight: 200, objectFit: "contain", marginBottom: 4 }} />)}
      </div>)}
    </div>}
  </section>;
}
