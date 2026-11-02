import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { PwaRegistration } from "@/components/PwaRegistration";
import { I18nProvider } from "@/hooks/useI18n";
import { LOCALE_PREFERENCE_KEY, parseLocale, resolveAcceptLanguage } from "@/lib/i18n/registry";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./noto-sans-mono.css";
import "./globals.css";
import "./settings.css";

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 首屏按保存的偏好或浏览器语言渲染，避免水合后再切换界面语言。
  const locale = parseLocale((await cookies()).get(LOCALE_PREFERENCE_KEY)?.value)
    ?? resolveAcceptLanguage((await headers()).get("accept-language"));
  return (
    <html lang={locale} translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        <link rel="preload" href="/fonts/noto-sans-mono-v37-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/noto-sans-mono-v37-cyrillic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/symbols-nerd-font-mono-v3.5.1.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
        <meta name="google" content="notranslate" />
        {/* THEME_INIT_SCRIPT preserves the inline new URLSearchParams(location.search).get("theme") seed contract. */}
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        <PwaRegistration />
      </body>
    </html>
  );
}
