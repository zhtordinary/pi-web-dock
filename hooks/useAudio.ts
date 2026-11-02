"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// 状态音：完成（AI 处理完）/ 报错 / 等待用户提交回答
const SOUND_URLS = {
  done: "/sounds/complete_fanfare.wav",
  error: "/sounds/error_down.wav",
  wait: "/sounds/wait_q_base.wav",
} as const;

export type SoundKey = keyof typeof SOUND_URLS;

// 模块级共享 AudioContext 单例：所有 ChatWindow 实例（含后台会话）共用。
// 它是浏览器借给页面的租约，不是“解锁一次就永久有效”：输出设备断开、系统休眠或音频
// 中断、页面被切走都会让浏览器把它收回，个别情形下 resume() 还会一直失败。页面生命
// 周期内只由下方“AudioContext 生命周期”一节负责维持，其他代码不直接创建或替换它。
let sharedCtx: AudioContext | null = null;
// 模块级同类音 2s 去重时间戳，以接受播放 intent 的时刻为起点。
const SOUND_DEDUP_WINDOW_MS = 2_000;
const SOUND_PENDING_MAX = 32;
const lastPlayedAt: Record<SoundKey, number> = { done: Number.NEGATIVE_INFINITY, error: Number.NEGATIVE_INFINITY, wait: Number.NEGATIVE_INFINITY };

// 声音 intent 使用跨文档 claim。顶层同源文档由 Web Locks 串行化
// “读—判重—写”，嵌入文档向已注册父级 AppShell 请求 claim；无法协调时明确降级
// 为 best-effort。claim 在播放前消费，播放结果不 rollback，优先保证 at-most-once。
type UnlockableAudioContextState = AudioContextState | "interrupted";

function isAudioContextUnlockBlocked(ctx: AudioContext): boolean {
  const state = ctx.state as UnlockableAudioContextState;
  return state === "suspended" || state === "interrupted";
}

export function shouldDeferSoundUntilUnlock(key: SoundKey, state: UnlockableAudioContextState): boolean {
  return (state === "suspended" || state === "interrupted") && key !== "wait";
}

const LEGACY_SOUNDED_WAIT_STORAGE_KEY = "pi-sounded-wait-ids";
const SOUND_CLAIM_STORAGE_KEY = "pi-sound-claims";
const SOUND_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// ponytail: 4096 entries bounds localStorage; beyond that long-tail replay is
// outside guarantee. Move claims to IndexedDB if higher event volume matters.
const SOUND_CLAIM_MAX = 4096;
const SOUND_CLAIM_TIMEOUT_MS = 5_000;
export const SOUND_LOAD_TIMEOUT_MS = 5_000;
export const SOUND_CLAIM_REQUEST_EVENT = "pi-web-sound-claim-request";
export const SOUND_CLAIM_RESPONSE_EVENT = "pi-web-sound-claim-response";

type SoundLockManager = {
  request: (name: string, callback: (lock: unknown) => Promise<boolean> | boolean) => Promise<boolean>;
};
type PendingSoundClaim = {
  resolve: (claimed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

let soundClaims: Map<string, number> | null = null;
let legacyWaitClaimsMigrated = false;
const pendingSoundClaims = new Map<string, PendingSoundClaim>();
const pendingSoundRequests = new Set<string>();

function randomSoundClaimId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function soundLockName(requestId: string): string {
  // Lock names are strings; avoid a short hash because collisions suppress valid sounds.
  return `pi-web-sound:${requestId}`;
}

function trimSoundClaims(claims: Map<string, number>): Map<string, number> {
  if (claims.size <= SOUND_CLAIM_MAX) return claims;
  const entries = [...claims.entries()]
    .sort(([, left], [, right]) => left - right)
    .slice(-SOUND_CLAIM_MAX);
  return new Map(entries);
}

function readSoundClaims(): Map<string, number> {
  const now = Date.now();
  const claims = new Map<string, number>();
  try {
    const raw = window.localStorage.getItem(SOUND_CLAIM_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && now - value < SOUND_CLAIM_TTL_MS) {
          claims.set(key, value);
        }
      }
    }
    // Migrate wait claims from 0.8.11 without preserving their old FIFO limit.
    if (!legacyWaitClaimsMigrated) {
      legacyWaitClaimsMigrated = true;
      const legacy = window.localStorage.getItem(LEGACY_SOUNDED_WAIT_STORAGE_KEY);
      const legacyIds = legacy ? JSON.parse(legacy) as unknown : null;
      if (Array.isArray(legacyIds)) {
        for (const id of legacyIds) {
          if (typeof id === "string") claims.set(`wait:${id}`, now);
        }
      }
    }
  } catch {
    // localStorage 不可用时退回当前文档内存状态。
  }
  if (soundClaims) {
    for (const [key, value] of soundClaims) {
      if (!claims.has(key) && now - value < SOUND_CLAIM_TTL_MS) claims.set(key, value);
    }
  }
  soundClaims = trimSoundClaims(claims);
  return soundClaims;
}

function writeSoundClaims(claims: Map<string, number>): void {
  soundClaims = trimSoundClaims(claims);
  try {
    window.localStorage.setItem(SOUND_CLAIM_STORAGE_KEY, JSON.stringify(Object.fromEntries(soundClaims)));
  } catch {
    // 内存集合仍可保护当前文档；跨文档保证在存储不可用时明确降级。
  }
}

async function claimAtTopLevel(requestId: string): Promise<boolean> {
  const claim = () => {
    const claims = readSoundClaims();
    if (claims.has(requestId)) return false;
    claims.set(requestId, Date.now());
    writeSoundClaims(claims);
    return true;
  };
  const locks = typeof navigator !== "undefined"
    ? (navigator as Navigator & { locks?: SoundLockManager }).locks
    : undefined;
  if (!locks || typeof locks.request !== "function") return claim();
  try {
    return await locks.request(soundLockName(requestId), () => claim());
  } catch {
    // Unsupported/failed lock implementations degrade to best-effort storage claim.
    return claim();
  }
}

function parentTargetOrigin(): string | null {
  try {
    const referrer = typeof document !== "undefined" ? document.referrer : "";
    if (!referrer) return null;
    const origin = new URL(referrer).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function installSoundClaimResponseListener(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; nonce?: unknown; claimed?: unknown } | null;
    if (data?.type !== SOUND_CLAIM_RESPONSE_EVENT || typeof data.nonce !== "string") return;
    const expectedOrigin = parentTargetOrigin();
    if (!expectedOrigin || event.origin !== expectedOrigin || event.source !== window.parent) return;
    const pending = pendingSoundClaims.get(data.nonce);
    if (!pending) return;
    pendingSoundClaims.delete(data.nonce);
    clearTimeout(pending.timer);
    pending.resolve(data.claimed === true);
  });
}

function claimThroughParent(requestId: string): Promise<boolean> {
  const targetOrigin = parentTargetOrigin();
  if (!targetOrigin) return Promise.resolve(false);
  const nonce = randomSoundClaimId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSoundClaims.delete(nonce);
      resolve(false);
    }, SOUND_CLAIM_TIMEOUT_MS);
    pendingSoundClaims.set(nonce, { resolve, timer });
    try {
      window.parent.postMessage(
        { type: SOUND_CLAIM_REQUEST_EVENT, nonce, requestId },
        targetOrigin,
      );
    } catch {
      clearTimeout(timer);
      pendingSoundClaims.delete(nonce);
      resolve(false);
    }
  });
}

export async function claimSoundRequest(requestId: string): Promise<boolean> {
  if (!requestId || requestId.length > 512) return false;
  if (typeof window !== "undefined" && window.parent && window.parent !== window) {
    return claimThroughParent(requestId);
  }
  return claimAtTopLevel(requestId);
}

installSoundClaimResponseListener();

export function tryPlaySoundRequest(
  requestId: string,
  playSound: () => Promise<boolean>,
  isEligible?: () => boolean,
): boolean {
  if (!requestId || pendingSoundRequests.has(requestId)) return false;
  try {
    if (isEligible && !isEligible()) return false;
  } catch {
    return false;
  }
  if (readSoundClaims().has(requestId)) return false;
  pendingSoundRequests.add(requestId);
  void claimSoundRequest(requestId)
    .then((claimed) => (claimed ? playSound() : false))
    .then(() => {
      // claim 不因播放结果 rollback：AudioContext/浏览器挂起时优先避免重复。
      pendingSoundRequests.delete(requestId);
    }, () => {
      pendingSoundRequests.delete(requestId);
    });
  return true;
}

// 会话级弹窗交互静默：用户在弹窗里交互（键盘输入/提交选择）后，短时间内
// 该会话新出现的弹窗不再播等待音。ask_user 是多步弹窗流程（选择 → 确认/
// 下一步），每步都是新 requestId，逐步播报听起来像「一操作就重复响」——
// 用户正在操作弹窗，弹窗可见，交互后的后续步骤无需再提醒。
// 模块级 Map（同文档内有效）：离开会话页（iframe 重载）即清空，恢复
// 「弹窗出现即播」——用户已切走，后台弹窗需要提醒。真正的连续问答
// （agent 思考超过窗口后才问下一个独立问题）不受影响，正常播报。
// ponytail: 窗口固定 30s，覆盖弹窗流程的确认/下一步间隔；独立新问题
// 通常在 30s 后，仍会播报。
const SESSION_DIALOG_SILENCE_MS = 30_000;
const sessionDialogInteractedAt = new Map<string, number>();

/** 弹窗交互（键盘输入/提交）时调用：记录该会话的最后交互时刻。 */
export function markSessionDialogInteracted(sessionId: string | undefined | null): void {
  if (!sessionId) return;
  try {
    sessionDialogInteractedAt.set(sessionId, Date.now());
  } catch {
    // 忽略
  }
}

/** 该会话是否处于「刚交互过弹窗」的静默窗口内（30s）。 */
export function wasSessionDialogRecentlyInteracted(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  const at = sessionDialogInteractedAt.get(sessionId);
  if (at === undefined) return false;
  // 过期条目即删，避免该 Map 随会话累积无界增长（仅用于 30s 静默窗口）。
  if (Date.now() - at >= SESSION_DIALOG_SILENCE_MS) {
    sessionDialogInteractedAt.delete(sessionId);
    return false;
  }
  return true;
}

export function waitSoundRequestId(requestId: string | undefined | null): string {
  const request = requestId?.trim();
  return request ? `wait:${request}` : "";
}

/** Stable terminal key. Missing server identity is deliberately not claimable. */
export function statusSoundRequestId(
  sessionId: string | undefined | null,
  kind: "done" | "error",
  runId?: string,
): string {
  const session = sessionId?.trim();
  const run = runId?.trim();
  return session && run ? `status:${kind}:${session}:${run}` : "";
}

export interface SoundSettings {
  enabled: boolean;
  done: boolean;
  error: boolean;
  wait: boolean;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  done: true,
  error: true,
  wait: true,
};

export const SOUND_SETTINGS_STORAGE_KEY = "pi-sound-settings";
const SOUND_ENABLED_STORAGE_KEY = "pi-sound-enabled";

export function readSoundSettings(): SoundSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SOUND_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SOUND_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
        done: typeof parsed.done === "boolean" ? parsed.done : true,
        error: typeof parsed.error === "boolean" ? parsed.error : true,
        wait: typeof parsed.wait === "boolean" ? parsed.wait : true,
      };
    }
    const legacy = window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY);
    if (legacy !== null) {
      return {
        ...DEFAULT_SOUND_SETTINGS,
        enabled: legacy !== "false",
      };
    }
  } catch {
    // localStorage 不可用时退回默认值
  }
  return { ...DEFAULT_SOUND_SETTINGS };
}

export function writeSoundSettings(settings: SoundSettings): void {
  try {
    window.localStorage.setItem(SOUND_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, String(settings.enabled));
  } catch {
    // 降级
  }
  setModuleSoundSettings(settings);
}

// 模块级声音配置镜像：多个 useAudio 实例（前台 ChatWindow + AppShell 全局
// 等待通道 + 设置面板）共享同一配置，任一实例变更后立即生效。
let moduleSoundSettings: SoundSettings | null = null;
const soundSettingsListeners = new Set<() => void>();

function readModuleSoundSettings(): SoundSettings {
  if (moduleSoundSettings === null) {
    moduleSoundSettings = readSoundSettings();
  }
  return moduleSoundSettings;
}

function setModuleSoundSettings(next: SoundSettings): void {
  moduleSoundSettings = { ...next };
  for (const listener of soundSettingsListeners) listener();
}

function subscribeSoundSettings(listener: () => void): () => void {
  soundSettingsListeners.add(listener);
  return () => soundSettingsListeners.delete(listener);
}

function readModuleSoundEnabled(): boolean {
  return readModuleSoundSettings().enabled;
}

function setModuleSoundEnabled(next: boolean): void {
  const current = readModuleSoundSettings();
  writeSoundSettings({ ...current, enabled: next });
}

function subscribeSoundEnabled(listener: () => void): () => void {
  return subscribeSoundSettings(listener);
}

function installSoundEnabledStorageListener(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== null && event.key !== SOUND_SETTINGS_STORAGE_KEY && event.key !== SOUND_ENABLED_STORAGE_KEY) return;
    moduleSoundSettings = null;
    const next = readSoundSettings();
    setModuleSoundSettings(next);
  });
}

installSoundEnabledStorageListener();

// 模块级缓存：三个小 wav 一次解码后复用，避免每次事件重复 fetch。
// 失败结果不入缓存，瞬态网络/解码故障可在下一次播放重试。
const bufferCache = new Map<SoundKey, AudioBuffer>();
const pendingFetches = new Map<SoundKey, Promise<AudioBuffer | null>>();
type PendingUnlockSound = {
  ctx: AudioContext;
  resolve: (played: boolean) => void;
};
const pendingUnlockSounds = new Map<SoundKey, PendingUnlockSound[]>();

function fetchBuffer(ctx: AudioContext, key: SoundKey): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = pendingFetches.get(key);
  if (inFlight) return inFlight;

  const attempt: {
    active: boolean;
    controller: AbortController | null;
    promise: Promise<AudioBuffer | null> | null;
    timeout: ReturnType<typeof setTimeout> | null;
  } = {
    active: true,
    controller: typeof AbortController === "function" ? new AbortController() : null,
    promise: null,
    timeout: null,
  };
  let settled = false;
  let resolveResult!: (value: AudioBuffer | null) => void;
  const settle = (value: AudioBuffer | null) => {
    if (settled) return;
    settled = true;
    attempt.active = false;
    if (attempt.timeout !== null) clearTimeout(attempt.timeout);
    if (pendingFetches.get(key) === attempt.promise) pendingFetches.delete(key);
    resolveResult(value);
  };
  const promise = new Promise<AudioBuffer | null>((resolve) => { resolveResult = resolve; });
  attempt.promise = promise;
  attempt.timeout = setTimeout(() => {
    attempt.controller?.abort();
    settle(null);
  }, SOUND_LOAD_TIMEOUT_MS);
  void (async () => {
    try {
      const response = await (attempt.controller
        ? fetch(SOUND_URLS[key], { signal: attempt.controller.signal })
        : fetch(SOUND_URLS[key]));
      if (!attempt.active) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      if (!attempt.active) return;
      const buffer = await ctx.decodeAudioData(data);
      if (!attempt.active) return;
      bufferCache.set(key, buffer);
      settle(buffer);
    } catch {
      settle(null);
    }
  })();
  pendingFetches.set(key, promise);
  return promise;
}

async function playBufferWhenRunning(ctx: AudioContext, key: SoundKey): Promise<boolean> {
  // 单次事件最多重试一次；成功解码的 AudioBuffer 仍复用，失败结果不污染缓存。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (ctx.state !== "running") return false;
    const buffer = await fetchBuffer(ctx, key);
    if (!buffer) continue;
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = 1;
      source.start();
      return true;
    } catch {
      // 继续一次重试；浏览器可能在 fetch/decode 期间改变 AudioContext 状态。
    }
  }
  return false;
}

function flushPendingUnlockSounds(ctx: AudioContext): void {
  for (const [key, pendingSounds] of pendingUnlockSounds) {
    const remaining: PendingUnlockSound[] = [];
    let playback = Promise.resolve();
    for (const pending of pendingSounds) {
      if (pending.ctx !== ctx || isAudioContextUnlockBlocked(ctx)) {
        remaining.push(pending);
        continue;
      }
      if (ctx.state === "closed" || !readModuleSoundEnabled()) {
        pending.resolve(false);
      } else {
        playback = playback
          .then(() => playBufferWhenRunning(ctx, key))
          .then(pending.resolve, () => pending.resolve(false));
      }
    }
    if (remaining.length > 0) pendingUnlockSounds.set(key, remaining);
    else pendingUnlockSounds.delete(key);
  }
}

// ---------------------------------------------------------------------------
// AudioContext 生命周期（唯一负责人）
// ---------------------------------------------------------------------------
// 恢复手段分三层，越往下越需要用户在场：
// 1. statechange：被挂起（suspended）就立刻 resume()，不需要手势的浏览器当场拿回；
// 2. 页面重新可见 / 获得焦点 / pageshow：对被挂起或 interrupted 的 context 再 resume()；
// 3. 用户手势：resume() 仍失败、或显示 running 但时钟不走，说明这个 context 已经没救，
//    换一个新的。解码好的 AudioBuffer 与 context 无关，可直接复用。
const AUDIO_RESUME_SETTLE_MS = 1_000;
const AUDIO_AUTO_RESUME_GAP_MS = 2_000;
const AUDIO_CLOCK_PROBE_MS = 150;
const AUDIO_CLOCK_PROBE_INTERVAL_MS = 60_000;
const AUDIO_REPLACE_COOLDOWN_MS = 10_000;
const AUDIO_UNLOCK_FORWARD_GAP_MS = 1_000;
const AUDIO_LOG_MAX = 64;
export const SOUND_UNLOCK_EVENT = "pi-web-sound-unlock";
const AUDIO_GESTURE_EVENTS = ["pointerdown", "mousedown", "touchstart", "touchend", "keydown", "click"] as const;

type AudioLogEntry = { at: number; event: string; state: string | null; detail?: string };
const audioLog: AudioLogEntry[] = [];
let audioRecovery: Promise<void> | null = null;
let lastAutoResumeAt = Number.NEGATIVE_INFINITY;
let lastClockOkAt = Number.NEGATIVE_INFINITY;
let lastReplacedAt = Number.NEGATIVE_INFINITY;
let lastUnlockForwardAt = Number.NEGATIVE_INFINITY;

function logAudio(event: string, detail?: string): void {
  audioLog.push({ at: Date.now(), event, state: sharedCtx?.state ?? null, ...(detail ? { detail } : {}) });
  if (audioLog.length > AUDIO_LOG_MAX) audioLog.shift();
}

/** 控制台排查入口：window.__piAudio()。只含 context 状态变化与每次被丢弃的声音及原因。 */
export function getAudioDiagnostics(): { state: string | null; currentTime: number | null; log: AudioLogEntry[] } {
  return { state: sharedCtx?.state ?? null, currentTime: sharedCtx?.currentTime ?? null, log: audioLog.slice() };
}

type UserActivationLike = { hasBeenActive: boolean; isActive: boolean };

function userActivation(): UserActivationLike | undefined {
  return typeof navigator !== "undefined"
    ? (navigator as Navigator & { userActivation?: UserActivationLike }).userActivation
    : undefined;
}

// 没有任何用户激活时浏览器必然拒绝启动/恢复 context，不做无意义的尝试；
// 不支持 userActivation 的浏览器无法判断，按“有”处理。
const hasBeenActive = (): boolean => userActivation()?.hasBeenActive ?? true;
const isActivationActive = (): boolean => userActivation()?.isActive ?? true;

function adoptContext(next: AudioContext): AudioContext {
  const previous = sharedCtx;
  sharedCtx = next;
  lastClockOkAt = Number.NEGATIVE_INFINITY;
  // 排队等解锁的声音跟着换到新的 context 上继续等。
  if (previous) {
    for (const queued of pendingUnlockSounds.values()) {
      for (const item of queued) if (item.ctx === previous) item.ctx = next;
    }
  }
  try {
    next.addEventListener("statechange", () => handleContextStateChange(next));
    // 输出设备断开 / 系统报告音频故障时，浏览器在 AudioContext 上触发 error。
    (next as unknown as EventTarget).addEventListener("error", () => handleContextError(next));
  } catch {
    // 没有 EventTarget 的旧 WebView：只靠手势与可见性恢复。
  }
  logAudio("created");
  return next;
}

function createSharedContext(): AudioContext | null {
  try {
    return adoptContext(new AudioContext());
  } catch {
    return null;
  }
}

function replaceContext(reason: string): AudioContext | null {
  const previous = sharedCtx;
  const next = createSharedContext();
  if (!next) return null;
  lastReplacedAt = Date.now();
  logAudio("replaced", reason);
  if (previous) {
    try {
      void Promise.resolve(previous.close()).catch(() => {});
    } catch {
      // 旧 context 已不可用，丢弃即可。
    }
  }
  return next;
}

/** 不需要用户手势的恢复尝试：限频，避免与浏览器自己的状态机来回抖动。 */
function resumeQuietly(ctx: AudioContext): void {
  const now = Date.now();
  if (!hasBeenActive() || now - lastAutoResumeAt < AUDIO_AUTO_RESUME_GAP_MS) return;
  lastAutoResumeAt = now;
  try {
    void Promise.resolve(ctx.resume()).then(() => {
      if (sharedCtx === ctx && ctx.state === "running") flushPendingUnlockSounds(ctx);
    }, () => {
      logAudio("auto-resume-rejected");
    });
  } catch {
    // AudioContext not available
  }
}

/** 没有手势时新建（或换）一个 context：浏览器允许就当场可用，不允许则留给下一次手势。 */
function renewContextQuietly(reason: string | null): void {
  if (!hasBeenActive()) return;
  const next = reason === null ? createSharedContext() : replaceContext(reason);
  if (next) resumeQuietly(next);
}

function handleContextStateChange(ctx: AudioContext): void {
  if (sharedCtx !== ctx) return;
  logAudio("statechange");
  if (ctx.state === "running") flushPendingUnlockSounds(ctx);
  // interrupted 由浏览器自己结束，脚本在中断期间 resume() 必然被拒；只处理 suspended。
  else if (ctx.state === "suspended") resumeQuietly(ctx);
  else if (ctx.state === "closed") renewContextQuietly(null);
}

function handleContextError(ctx: AudioContext): void {
  if (sharedCtx !== ctx) return;
  logAudio("error");
  // 设备出错后这个 context 不可信：能立即换就换，否则留给下一次手势。
  if (Date.now() - lastReplacedAt > AUDIO_REPLACE_COOLDOWN_MS) renewContextQuietly("device-error");
}

async function resumeWithin(ctx: AudioContext, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 没有激活时 resume() 可能一直 pending，所以只等有限时间。
    await Promise.race([
      ctx.resume(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } catch {
    // 被拒绝：按“没恢复”处理。
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return ctx.state === "running";
}

async function clockAdvances(ctx: AudioContext): Promise<boolean> {
  const before = ctx.currentTime;
  await new Promise<void>((resolve) => { setTimeout(resolve, AUDIO_CLOCK_PROBE_MS); });
  return ctx.currentTime > before;
}

async function recoverInGesture(): Promise<void> {
  try {
    const ctx = sharedCtx && sharedCtx.state !== "closed" ? sharedCtx : createSharedContext();
    if (!ctx) return;
    let alive = ctx.state === "running";
    if (!alive && isAudioContextUnlockBlocked(ctx)) {
      alive = await resumeWithin(ctx, AUDIO_RESUME_SETTLE_MS);
      if (!alive) logAudio("resume-failed", ctx.state);
    } else if (alive && Date.now() - lastClockOkAt > AUDIO_CLOCK_PROBE_INTERVAL_MS && typeof ctx.currentTime === "number") {
      // 显示 running 并不保证输出还活着（休眠/换设备后可能无声）：时钟不走就是死了。
      // 读不到时钟的环境无法判断，不判死也不起定时器。
      alive = await clockAdvances(ctx);
      if (alive) lastClockOkAt = Date.now();
      else logAudio("clock-stalled");
    }
    // 只在浏览器确认用户激活仍有效时才换：此时新 context 才有机会被允许启动。
    if (!alive && isActivationActive() && Date.now() - lastReplacedAt > AUDIO_REPLACE_COOLDOWN_MS) {
      const next = replaceContext("unrecoverable");
      if (next && isAudioContextUnlockBlocked(next)) await resumeWithin(next, AUDIO_RESUME_SETTLE_MS);
    }
    if (sharedCtx?.state === "running") flushPendingUnlockSounds(sharedCtx);
  } catch {
    // 恢复失败不得影响页面其他功能；下一次手势再试。
  }
}

/** 手势内调用：保证存在一个可用的 context，必要时换新。同一时刻只有一个恢复流程。 */
export function ensureAudioReady(): Promise<void> {
  if (!audioRecovery) {
    audioRecovery = recoverInGesture().finally(() => { audioRecovery = null; });
  }
  return audioRecovery;
}

/** 非手势信号（页面重新可见 / 获得焦点 / pageshow）：只尝试恢复现有 context。 */
function recoverAudio(): void {
  if (!readModuleSoundEnabled()) return;
  const ctx = sharedCtx;
  if (!ctx) return; // 还没有手势解锁过，没有可恢复的。
  if (ctx.state === "closed") renewContextQuietly(null);
  else if (isAudioContextUnlockBlocked(ctx)) resumeQuietly(ctx);
}

// 嵌入的 Reader（iframe）里的手势到不了外层文档，而完整设备视图里的状态音由外层播。
// 把手势转告外层，让它的 context 也在用户在场时得到恢复。
function forwardGestureToParent(): void {
  if (typeof window === "undefined" || !window.parent || window.parent === window) return;
  const now = Date.now();
  if (now - lastUnlockForwardAt < AUDIO_UNLOCK_FORWARD_GAP_MS) return;
  const targetOrigin = parentTargetOrigin();
  if (!targetOrigin) return;
  lastUnlockForwardAt = now;
  try {
    window.parent.postMessage({ type: SOUND_UNLOCK_EVENT }, targetOrigin);
  } catch {
    // 父级不可达：只影响外层的恢复时机。
  }
}

function onUserGesture(): void {
  try {
    forwardGestureToParent();
    if (!readModuleSoundEnabled()) return;
    // 常态：context 在跑且近期确认过时钟，什么都不做。
    if (sharedCtx?.state === "running" && Date.now() - lastClockOkAt <= AUDIO_CLOCK_PROBE_INTERVAL_MS) return;
    void ensureAudioReady();
  } catch {
    // 监听器不得影响页面交互。
  }
}

function installAudioLifecycle(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  for (const type of AUDIO_GESTURE_EVENTS) {
    window.addEventListener(type, onUserGesture, { capture: true, passive: true });
  }
  const onPresence = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    recoverAudio();
  };
  window.addEventListener("pageshow", onPresence);
  window.addEventListener("focus", onPresence);
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onPresence);
  }
  try {
    (window as unknown as { __piAudio?: typeof getAudioDiagnostics }).__piAudio = getAudioDiagnostics;
  } catch {
    // 只读 window：不影响功能。
  }
}

installAudioLifecycle();

function playBuffer(ctx: AudioContext, key: SoundKey): Promise<boolean> {
  if (isAudioContextUnlockBlocked(ctx)) {
    if (!shouldDeferSoundUntilUnlock(key, ctx.state as UnlockableAudioContextState)) return Promise.resolve(false);
    let resolvePending!: (played: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { resolvePending = resolve; });
    const pendingSounds = pendingUnlockSounds.get(key) ?? [];
    if (pendingSounds.length >= SOUND_PENDING_MAX) {
      // Keep the newest intents; an old deferred tone is less useful after a long lock.
      pendingSounds.shift()?.resolve(false);
    }
    pendingSounds.push({ ctx, resolve: resolvePending });
    pendingUnlockSounds.set(key, pendingSounds);
    resumeQuietly(ctx);
    return promise;
  }
  if (ctx.state === "closed") return Promise.resolve(false);
  return playBufferWhenRunning(ctx, key);
}

export function useAudio() {
  const [settings, setSettings] = useState<SoundSettings>(() => readModuleSoundSettings());

  const settingsRef = useRef(settings);
  useEffect(() => {
    const sync = () => {
      const next = readModuleSoundSettings();
      settingsRef.current = next;
      setSettings(next);
    };
    const unsubscribe = subscribeSoundSettings(sync);
    sync();
    return unsubscribe;
  }, []);

  const enabled = settings.enabled;
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // 模块级共享 AudioContext 单例：所有 ChatWindow 实例（含后台会话）共用。
  // 浏览器 autoplay 策略下，脱离手势新建的 ctx 处于 suspended 且 resume 会被拒，
  // 由生命周期一节在下一次手势/可见性信号里恢复。
  const getCtx = useCallback((): AudioContext | null => {
    if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
    return createSharedContext();
  }, []);

  // 手势入口（发送消息、打开声音开关等）；全局手势监听也走同一个 ensureAudioReady。
  const unlockAudio = useCallback((force = false) => {
    if (!force && !readModuleSoundEnabled()) return;
    void ensureAudioReady();
  }, []);

  const updateSoundSettings = useCallback((patch: Partial<SoundSettings>) => {
    const current = readModuleSoundSettings();
    const next: SoundSettings = { ...current, ...patch };
    if (next.enabled) unlockAudio(true);
    writeSoundSettings(next);
    settingsRef.current = next;
    setSettings(next);
  }, [unlockAudio]);

  const toggle = useCallback(() => {
    const current = readModuleSoundSettings();
    updateSoundSettings({ enabled: !current.enabled });
  }, [updateSoundSettings]);

  // 试听来自一次点击：先把 context 恢复到可用（必要时换新），再播。
  const playPreviewSound = useCallback(async (key: SoundKey): Promise<boolean> => {
    await ensureAudioReady();
    const ctx = getCtx();
    if (!ctx) return false;
    return playBuffer(ctx, key).catch(() => false);
  }, [getCtx]);

  const canPlaySound = useCallback((key: SoundKey): boolean => {
    const s = readModuleSoundSettings();
    const playable = Boolean(s.enabled && s[key] && sharedCtx?.state === "running");
    if (!playable) {
      // 被丢弃的声音必须留下原因，否则“没响”无从排查。
      logAudio("dropped", `${key}:${!s.enabled ? "disabled" : !s[key] ? "key-off" : sharedCtx?.state ?? "no-context"}`);
    }
    return playable;
  }, []);

  const play = useCallback((key: SoundKey): Promise<boolean> => {
    const s = readModuleSoundSettings();
    if (!s.enabled || !s[key]) return Promise.resolve(false);
    // 模块级同类音 2s 去重：多个后台会话同时完成/报错时只响一声。
    const now = Date.now();
    if (now - lastPlayedAt[key] < SOUND_DEDUP_WINDOW_MS) return Promise.resolve(false);
    const ctx = getCtx();
    if (!ctx) return Promise.resolve(false);
    // 等待音的陈旧通知不排队，避免用户首次交互时补播已经过期的弹窗。
    if (isAudioContextUnlockBlocked(ctx) && !shouldDeferSoundUntilUnlock(key, ctx.state as UnlockableAudioContextState)) return Promise.resolve(false);
    if (ctx.state === "closed") return Promise.resolve(false);
    lastPlayedAt[key] = now;
    return playBuffer(ctx, key).catch(() => false);
  }, [getCtx]);

  const playDoneSound = useCallback(() => play("done"), [play]);
  const playErrorSound = useCallback(() => play("error"), [play]);
  const playWaitSound = useCallback(() => play("wait"), [play]);

  return {
    soundEnabled: enabled,
    soundSettings: settings,
    updateSoundSettings,
    playPreviewSound,
    onSoundToggle: toggle,
    playDoneSound,
    playErrorSound,
    playWaitSound,
    unlockAudio,
    soundEnabledRef: enabledRef,
    canPlaySound,
  };
}
