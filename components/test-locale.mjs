import { interpolateMessage } from "../lib/i18n/format.ts";
import { enLocale as catalogEn } from "../lib/i18n/messages/en.ts";
import { zhCNLocale as catalogZhCN } from "../lib/i18n/messages/zh-CN.ts";
import { zhTWLocale as catalogZhTW } from "../lib/i18n/messages/zh-TW.ts";

const catalogs = { en: catalogEn.messages, "zh-CN": catalogZhCN.messages, "zh-TW": catalogZhTW.messages };

/**
 * Static component renders start in the provider's default locale because
 * effects do not run under react-dom/server. Keep those assertions in the
 * language used by their expected UI copy without changing the production
 * provider or its runtime default.
 */
export async function installEnglishTestLocale(jiti) {
  const [{ enLocale }, { zhCNLocale }] = await Promise.all([
    jiti.import("@/lib/i18n/messages/en.ts"),
    jiti.import("@/lib/i18n/messages/zh-CN.ts"),
  ]);
  zhCNLocale.messages = enLocale.messages;
}

/**
 * Translate with the shipped catalog, for production code evaluated outside
 * React. An unknown key fails the test instead of rendering the key itself.
 */
export function testTranslator(locale = "en") {
  const messages = catalogs[locale];
  return (key, params) => {
    const message = messages[key];
    if (message === undefined) throw new Error(`Missing ${locale} message: ${key}`);
    return interpolateMessage(message, params);
  };
}

/** The text React writes into static markup for a message. */
export function markupText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** Han characters and CJK punctuation, which an English page must not show. */
export const CJK_TEXT = /[　-〿㐀-䶿一-鿿＀-￯]/u;
