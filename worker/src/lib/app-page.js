/**
 * app-page — the HTML shell for the owner's app, and the brand assets a shared
 * invite needs.
 *
 * The app itself is React and lives in frontend/; this serves the document that
 * loads it, plus everything a messaging app reads when the invite link is
 * pasted into a conversation: title, description, favicon, and generic Open
 * Graph and Twitter cards. Client identity remains behind authentication.
 *
 * Keeping the shell here rather than shipping frontend/dist means the Worker
 * still serves one reviewed module, and the client never runs a build.
 */

import { APP_BUNDLE_ID } from "./app-assets.js";
import { SEARCH_UNAVAILABLE, unavailableNotice } from "./retrieval-status.js";

// Fallback only. The worker sends `notice` with the response; this covers a
// cached page talking to a worker that did not.
const GENERIC_UNAVAILABLE_NOTICE = unavailableNotice("unknown");

/**
 * The brand mark, as a standalone SVG. Served at /brand/og.svg for link
 * previews and reused inline for the favicon. It is deliberately generic:
 * messaging scrapers are unauthenticated, so a shared link must not disclose
 * the configured owner or brain name before the recipient signs in.
 */
export function brandOgSvg(_env) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Private Financial Brain">
  <rect width="1200" height="630" fill="#12141a"/>
  <circle cx="960" cy="140" r="300" fill="#3b5bdb" opacity="0.14"/>
  <circle cx="200" cy="560" r="240" fill="#3b5bdb" opacity="0.10"/>
  <text x="96" y="330" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="76" font-weight="600" letter-spacing="-2">Private Financial Brain</text>
  <text x="96" y="404" fill="#aab3c5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="34">Everything you have written, decided and been told.</text>
  <text x="96" y="452" fill="#aab3c5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="34">Ask it anything. It answers with its sources.</text>
  <text x="96" y="556" fill="#7d94f5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="27" letter-spacing="1">PRIVATE  ·  YOURS  ·  OPENS WITH YOUR FACE</text>
</svg>`;
}

// Inline so the tab icon needs no second request and no route of its own.
export const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<circle cx="16" cy="16" r="11" fill="#3b5bdb"/></svg>');

export function appPageHtml(_env, origin = "") {
  // This shell, its metadata, and its preview image are public. Per-install
  // identity becomes visible only after /api/app/me proves a live session.
  const headline = "Private Financial Brain";
  const description =
    "Everything you have written, decided and been told, in one place you own. " +
    "Ask it anything and it answers with its sources. Opens with your face or fingerprint, never a password.";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${headline}">
<meta name="theme-color" content="#12141a">
<title>${headline}</title>
<meta name="description" content="${description}">
<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${FAVICON}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${headline}">
<meta property="og:title" content="${headline}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${origin}/brand/og.svg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${origin}/app">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${headline}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${origin}/brand/og.svg">
<link rel="stylesheet" href="/app/assets/app.css?v=${APP_BUNDLE_ID}">
<body><div id="root"></div>
<script type="module" src="/app/assets/app.js?v=${APP_BUNDLE_ID}"></script>
</html>`;
}
