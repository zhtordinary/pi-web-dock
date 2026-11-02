/** Browser-side Web Push state and explicit subscription controls. */

let activeSubscriptionPromise: Promise<boolean> | null = null;
let activeUnsubscriptionPromise: Promise<boolean> | null = null;

// Standard base64url → Uint8Array conversion for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export function pushPermission(): NotificationPermission | "unsupported" {
  return isPushSupported() ? Notification.permission : "unsupported";
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

async function registerSubscription(locale: string, requestPermission: boolean): Promise<boolean> {
  if (!isPushSupported()) return false;
  let permission = Notification.permission;
  if (permission === "default" && requestPermission) permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const configResponse = await fetch("/api/push/config", { cache: "no-store" });
  if (!configResponse.ok) return false;
  const { publicKey } = await configResponse.json() as { publicKey?: string };
  if (!publicKey) return false;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  let created = false;
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    created = true;
  }

  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
  });
  if (response.ok) return true;
  if (created) await subscription.unsubscribe().catch(() => {});
  return false;
}

function subscribe(locale: string, requestPermission: boolean): Promise<boolean> {
  if (activeSubscriptionPromise) return activeSubscriptionPromise;
  const attempt = registerSubscription(locale, requestPermission).catch(() => false);
  activeSubscriptionPromise = attempt;
  void attempt.then(() => {
    if (activeSubscriptionPromise === attempt) activeSubscriptionPromise = null;
  });
  return attempt;
}

/** Existing callers use this only after permission was granted. */
export function setupPushSubscription(locale: string): Promise<boolean> {
  return subscribe(locale, false);
}

/** Explicit user-gesture entry point: may request Notification permission. */
export function requestPushSubscription(locale: string): Promise<boolean> {
  return subscribe(locale, true);
}

export function unsubscribePushSubscription(): Promise<boolean> {
  if (activeUnsubscriptionPromise) return activeUnsubscriptionPromise;
  const attempt = (async () => {
    const subscription = await getPushSubscription();
    if (!subscription) return true;
    const response = await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    if (!response.ok) return false;
    return subscription.unsubscribe();
  })().catch(() => false);
  activeUnsubscriptionPromise = attempt;
  void attempt.then(() => {
    if (activeUnsubscriptionPromise === attempt) activeUnsubscriptionPromise = null;
  });
  return attempt;
}
