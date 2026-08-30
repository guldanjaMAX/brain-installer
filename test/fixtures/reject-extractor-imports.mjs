const EXTRACTOR_PACKAGES = new Set([
  "@e965/xlsx",
  "fflate",
  "postal-mime",
  "unpdf",
]);

const forbiddenUrl = (url) => {
  let pathname = String(url || "");
  try { pathname = decodeURIComponent(new URL(pathname).pathname); } catch {}
  pathname = pathname.replaceAll("\\", "/");
  return pathname.endsWith("/ingest/formats.mjs") ||
    [...EXTRACTOR_PACKAGES].some((name) => pathname.includes(`/node_modules/${name}/`));
};

const refuse = (identity) => {
  throw new Error(`FORBIDDEN_EXTRACTOR_IMPORT:${identity}`);
};

export async function resolve(specifier, context, nextResolve) {
  if (EXTRACTOR_PACKAGES.has(specifier)) refuse(specifier);
  const resolved = await nextResolve(specifier, context);
  if (forbiddenUrl(resolved.url)) refuse(resolved.url);
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (forbiddenUrl(url)) refuse(url);
  return nextLoad(url, context);
}
