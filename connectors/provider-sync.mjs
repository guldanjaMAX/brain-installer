// Repository-level compatibility entrypoint. The canonical implementation
// lives inside worker/src so Cloudflare's module uploader includes it.
export * from "../worker/src/lib/provider-sync.js";
