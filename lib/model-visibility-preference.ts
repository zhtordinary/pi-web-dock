/**
 * Provider/模型折叠偏好（三机同步版）。
 *
 * 2026-08-17 前折叠状态存浏览器 localStorage（每端口/浏览器/设备独立，
 * 换端口或设备就全部展开）。本次改为并入三机同步的 models.json 顶层
 * `collapsedProviders` 字段：本模块保留同步 read/write API（调用点不变），
 * 内部维护一份内存缓存作为镜像，写入时异步 PUT 到服务端持久化，
 * 经 Syncthing 三机收敛；同窗口多组件用 COLLAPSED_PROVIDERS_CHANGED_EVENT
 * 通知刷新，跨 monitor iframe 仍用 postMessage（SYNC/REQUEST）即时同步。
 */

// 兼容遗留引用：浏览器端常量仍保留（已不再读写 localStorage）。
export const COLLAPSED_PROVIDERS_STORAGE_KEY = "pi-web:models-config-collapsed-providers";
export const COLLAPSED_PROVIDERS_CHANGED_EVENT = "pi-web:models-config-collapsed-providers-changed";
export const COLLAPSED_PROVIDERS_SYNC_EVENT = "pi-web:models-config-collapsed-providers-sync";
export const COLLAPSED_PROVIDERS_REQUEST_EVENT = "pi-web:models-config-collapsed-providers-request";

export const COLLAPSED_API = "models-config/collapsed-providers";

export function normalizeCollapsedProviderNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && name.trim().length > 0))];
}

// 内存缓存：models.json 折叠字段的镜像。模块级单例，跨组件共享。
let cached: string[] = [];
let loaded = false;

async function persist(names: readonly string[]): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await fetch(`/api/${COLLAPSED_API}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collapsedProviders: names }),
    });
    if (!res.ok) {
      console.warn("[pi-web] failed to persist collapsed providers:", res.status);
    }
  } catch (error) {
    console.warn("[pi-web] collapsed providers persist failed:", String(error));
  }
}

/** 启动/激活时预取一次服务端折叠状态；失败时保持空缓存（组件可继续折叠）。
 * 一旦本地已发生过写入（writeCollapsedProviderNames 将 loaded 置真），
 * 本地缓存即为最新权威，忽略仍可能到达的服务端旧值，避免覆盖用户刚做的折叠。 */
export function loadCollapsedProviderNames(): void {
  if (typeof window === "undefined") return;
  fetch(`/api/${COLLAPSED_API}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (loaded) return;
      cached = normalizeCollapsedProviderNames(data?.collapsedProviders);
      loaded = true;
      window.dispatchEvent(new Event(COLLAPSED_PROVIDERS_CHANGED_EVENT));
    })
    .catch((error) => console.warn("[pi-web] collapsed providers load failed:", String(error)));
}

export function readCollapsedProviderNames(): string[] {
  return cached;
}

export function writeCollapsedProviderNames(names: readonly string[]): void {
  const normalized = normalizeCollapsedProviderNames(names);
  cached = normalized;
  loaded = true;
  window.dispatchEvent(new Event(COLLAPSED_PROVIDERS_CHANGED_EVENT));
  void persist(normalized);
}

/** 服务端折叠状态是否已成功预取加载；未加载时写回前应跳过，避免用空缓存覆盖。 */
export function isCollapsedProvidersLoaded(): boolean {
  return loaded;
}
