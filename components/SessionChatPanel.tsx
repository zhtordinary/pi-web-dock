"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SettingsSection } from "@/lib/settings-navigation";
import type { SessionInfo } from "@/lib/types";
import type { SessionForkResult } from "@/hooks/useAgentSession";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";

type Props = {
  sessionId: string;
  running: boolean;
  remotePeer?: string | null;
  initialPrompt?: string | null;
  onInitialPromptConsumed?: () => void;
  modelsRefreshKey?: number;
  onOpenFile?: (filePath: string) => void;
  onSessionForked?: (result: SessionForkResult) => void;
  onOpenSettings?: (section: SettingsSection) => void;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
};

const RETRY_MS = 1000;

function sessionUrl(sessionId: string, remotePeer?: string | null): string {
  const encoded = encodeURIComponent(sessionId);
  return remotePeer
    ? `/api/remote/sessions/${encoded}?peer=${encodeURIComponent(remotePeer)}`
    : `/api/sessions/${encoded}`;
}

export function SessionChatPanel({ sessionId, running, remotePeer, initialPrompt, onInitialPromptConsumed, modelsRefreshKey, onOpenFile, onSessionForked, onOpenSettings, soundEnabled, onSoundToggle, playDoneSound, unlockAudio }: Props) {
  const { t } = useI18n();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "error">("loading");
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(sessionUrl(sessionId, remotePeer), { signal: controller.signal, cache: "no-store" });
        if (response.status === 404) {
          setState("missing");
          if (running) retry = setTimeout(() => void load(), RETRY_MS);
          return;
        }
        const data = await response.json() as { info?: SessionInfo };
        if (data.info) {
          setInfo(data.info);
          setState("loading");
        } else setState("error");
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) setState("error");
      }
    };
    void load();
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [remotePeer, running, sessionId]);

  if (info) {
    return (
      <ChatWindow
        session={info}
        sessionRunning={running}
        newSessionCwd={null}
        newSessionDraftKey={null}
        remotePeer={remotePeer ?? undefined}
        initialPrompt={initialPrompt}
        onInitialPromptConsumed={onInitialPromptConsumed}
        chatInputRef={chatInputRef}
        modelsRefreshKey={modelsRefreshKey}
        onOpenFile={onOpenFile}
        onSessionForked={onSessionForked}
        onOpenSettings={onOpenSettings}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
        suppressStatusSounds
        panel
      />
    );
  }

  return (
    <div role={state === "error" ? "alert" : undefined} style={{ padding: 24, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
      {t(state === "loading" || running ? "sessionPanel.loading" : state === "missing" ? "sessionPanel.missing" : "sessionPanel.error")}
    </div>
  );
}
