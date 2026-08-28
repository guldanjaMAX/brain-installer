/**
 * app-page — the HTML shell for the owner's app, and the brand assets a shared
 * invite needs.
 *
 * The app itself is React and lives in frontend/; this serves the document that
 * loads it, plus everything a messaging app reads when the invite link is
 * pasted into a conversation: title, description, favicon, and Open Graph and
 * Twitter cards pointing at a preview image generated per install.
 *
 * Keeping the shell here rather than shipping frontend/dist means the Worker
 * still serves one reviewed module, and the client never runs a build.
 */

import { APP_BUNDLE_ID } from "./app-assets.js";
import { SEARCH_UNAVAILABLE, unavailableNotice } from "./retrieval-status.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Fallback only. The worker sends `notice` with the response; this covers a
// cached page talking to a worker that did not.
const GENERIC_UNAVAILABLE_NOTICE = unavailableNotice("unknown");

/**
 * The brand mark, as a standalone SVG. Served at /brand/og.svg for link
 * previews and reused inline for the favicon, so a shared invite carries the
 * brain's own identity instead of a bare URL.
 *
 * Everything is drawn from per-install configuration. A hardcoded name or
 * logo here would ship one client's identity to every other client.
 */
export function brandOgSvg(env) {
  const owner = esc(env.BRAIN_OWNER || "Your");
  const possessive = /s$/i.test(owner) ? `${owner}'` : `${owner}'s`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${possessive} brain">
  <rect width="1200" height="630" fill="#12141a"/>
  <circle cx="960" cy="140" r="300" fill="#3b5bdb" opacity="0.14"/>
  <circle cx="200" cy="560" r="240" fill="#3b5bdb" opacity="0.10"/>
  <g transform="translate(96,150)">
    <svg viewBox="6 24 88 52" width="132" height="78">
      <path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z"
            fill="none" stroke="#7d94f5" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </g>
  <text x="96" y="330" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="76" font-weight="600" letter-spacing="-2">${possessive} brain</text>
  <text x="96" y="404" fill="#aab3c5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="34">Everything you have written, decided and been told.</text>
  <text x="96" y="452" fill="#aab3c5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="34">Ask it anything. It answers with its sources.</text>
  <text x="96" y="556" fill="#7d94f5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="27" letter-spacing="1">PRIVATE  ·  YOURS  ·  OPENS WITH YOUR FACE</text>
</svg>`;
}

// Inline so the tab icon needs no second request and no route of its own.
export const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 24 88 52">' +
  '<path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z" ' +
  'fill="none" stroke="#3b5bdb" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/></svg>');

export function appPageHtml(env, origin = "") {
  const brainName = esc(env.BRAIN_NAME || "Your brain");
  const owner = esc(env.BRAIN_OWNER || "");
  // "Dana's brain", but "Chris' brain" — a possessive that reads wrong
  // is the first thing a client notices about a page built for them.
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "";
  const headline = possessive ? `${possessive} brain` : brainName;
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
<body><div id="root" data-owner="${owner}" data-brain="${brainName}"></div>
<script type="module" src="/app/assets/app.js?v=${APP_BUNDLE_ID}"></script>
</html>`;
}
