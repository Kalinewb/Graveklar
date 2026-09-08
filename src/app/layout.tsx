import type { Metadata } from "next";
import type React from "react";
import { Geist, Geist_Mono } from "next/font/google";

export const dynamic = 'force-dynamic';
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { loadAppConfig } from "@/lib/app-config";
import { db } from "@/lib/db";
import { buildLocalBusinessJsonLd, buildSiteMetadata, buildWebSiteJsonLd } from "@/lib/seo";
// The accent → CSS-variable mixing lives in src/lib/accent-style.ts so it is
// unit-testable without rendering this Server Component (finding R-3).
import { buildAccentStyle } from "@/lib/accent-style";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadAppConfig();
  const machines = await db.machine.findMany({
    where: { isActive: true },
    select: { name: true, model: true, category: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const meta = buildSiteMetadata(cfg, machines);
  const logoUrl = cfg['logoUrl'] || '';
  const useLogoFavicon = cfg['logoAsFavicon'] === 'true' && !!logoUrl;
  const logoMime = /\.svg$/i.test(logoUrl)
    ? 'image/svg+xml'
    : /\.jpe?g$/i.test(logoUrl)
      ? 'image/jpeg'
      : /\.webp$/i.test(logoUrl)
        ? 'image/webp'
        : 'image/png';

  // Icon set, in the order a consumer should prefer it. Everything here is
  // served from the site root on purpose: robots.txt disallows /api for every
  // crawler, so the previous single `/api/icon` favicon was unfetchable by
  // Googlebot-Image and search results showed the generic globe instead.
  //
  //   favicon.ico       — what crawlers and older browsers probe for blindly
  //   brand-icon.svg    — scalable, follows the admin accentColor
  //   icon-192/512.png  — raster fallbacks, and what the manifest installs
  //   apple-touch-icon  — iOS "Legg til på Hjem-skjerm"
  const brandIcons: NonNullable<Metadata['icons']> = {
    icon: [
      { url: '/favicon.ico', sizes: '48x48', type: 'image/x-icon' },
      { url: '/brand-icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: ['/favicon.ico'],
  };

  return {
    ...meta,
    manifest: '/manifest.webmanifest',
    icons: useLogoFavicon
      ? { ...brandIcons, icon: [{ url: logoUrl, type: logoMime }] }
      : brandIcons,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cfg = await loadAppConfig();
  const accentStyle = buildAccentStyle(cfg['accentColor'] || '') as React.CSSProperties | undefined;
  const machines = await db.machine.findMany({
    where: { isActive: true },
    select: { name: true, model: true, category: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const jsonLd = [
    buildLocalBusinessJsonLd(cfg, machines),
    buildWebSiteJsonLd(cfg),
  ];
  const jsonLdHtml = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

  return (
    <html lang="nb" suppressHydrationWarning style={accentStyle}>
      <body suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        {/* Self-heal handler for post-deploy ChunkLoadError.
            Inline + first-in-body so it installs the listeners before any
            Next bootstrap chunk loads. Auto-reloads the tab ONCE per
            60-second window when a stale chunk reference fires — recovers
            customers who had a tab open during a deploy without them
            having to know about Ctrl+Shift+R.

            Disabled in development because HMR routinely triggers chunk
            churn that would otherwise auto-reload on every save. */}
        {process.env.NODE_ENV === 'production' && (
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){var K='__chunk_reload_at__';var C=60000;var done=false;function isChunkErr(e){if(!e)return false;var m=e.message||String(e);var n=e.name||'';return n==='ChunkLoadError'||/Loading chunk \\S+ failed/.test(m)||/Failed to (?:fetch|load) (?:dynamically imported module|chunk)/.test(m);}function maybe(e){if(done||!isChunkErr(e))return;try{var p=parseInt(sessionStorage.getItem(K)||'0',10);if(Date.now()-p<C)return;sessionStorage.setItem(K,String(Date.now()));}catch(_){}done=true;console.warn('[chunk-reload] stale chunk detected, reloading');setTimeout(function(){location.reload();},250);}window.addEventListener('error',function(e){maybe(e.error||{message:e.message});});window.addEventListener('unhandledrejection',function(e){maybe(e.reason);});})();`,
            }}
          />
        )}
        <script
          type="application/ld+json"
          // Escape `<` so an admin-set config value containing `</script>`
          // (e.g. in businessName) can't break out of this inline block.
          // JSON.stringify alone does not escape `/`, and the CSP allows
          // inline scripts, so this is the relevant guard.
          dangerouslySetInnerHTML={{ __html: jsonLdHtml }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme={cfg['defaultTheme'] || 'light'}
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster position="top-center" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
