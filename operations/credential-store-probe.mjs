/**
 * Prove the credential store on THIS machine can be read back, before it holds
 * anything that matters.
 *
 * The store is the whole install. If it cannot return what it stored, the
 * client's admin key is gone and their brain is unreachable — and the way that
 * has been discovered until now is during real work, days later, with no clue
 * pointing back at the store. Windows is where this bites: the value is sealed
 * with DPAPI CurrentUser through a compiled helper, so a machine can write
 * happily and fail only on the way back out.
 *
 * WHAT THIS EXERCISES, exactly, and nothing more:
 *
 *   The production write and read functions, unmodified — the same private file
 *   creation, the same Windows ACL, the same DPAPI protect and unprotect, the
 *   same envelope encode and decode that a real admin key goes through.
 *
 * WHAT IT DOES NOT TOUCH: any real credential, and any real install. The value
 * is a fixed, published, non-secret string, and it is written into a private
 * temporary directory this function creates and removes. It never goes near a
 * manifest's `.brain-admin-key`, never near a Keychain item, and never near the
 * Cloudflare token store.
 *
 * The stage is reported because "could not write" and "could not read back" are
 * different problems with different fixes, and the reported field failure was
 * specifically the second one.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAdminKeyFile, writeAdminKeyFile } from "./admin-key-file.mjs";

/**
 * Fixed and deliberately self-describing. Anyone who finds this string in a
 * log, a crash dump or a leftover temporary file should be able to tell at a
 * glance that no credential was involved. It satisfies the admin-key value
 * contract (24 to 512 header-safe ASCII characters, no surrounding space) so it
 * travels the identical code path a real key does.
 */
export const CREDENTIAL_STORE_PROBE_VALUE =
  "brain-doctor-store-probe-this-is-not-a-credential";

/** Non-secret description of what the store on this platform actually is. */
export function credentialStoreDescription(platform = process.platform) {
  return platform === "win32"
    ? "a DPAPI CurrentUser envelope only this Windows account can read"
    : "an owner-only file (mode 0600)";
}

/** True when this platform seals the stored value rather than only permissioning it. */
export function credentialStoreIsEncrypted(platform = process.platform) {
  return platform === "win32";
}

function messageOf(error) {
  const text = String(error?.message || error || "").trim();
  return text || "no reason was reported";
}

/**
 * Write a fixed value through the real store, read it back, compare it exactly.
 *
 * Never throws: a probe that explodes is a diagnostic that took the machine
 * down with it. Returns `{ ok, stage, platform, encrypted, description, error }`
 * where `stage` is "write", "read", "compare", or "setup" when even the private
 * temporary directory could not be created.
 */
export function probeCredentialStore(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const username = options.username ?? environment.USERNAME ?? environment.USER;
  const write = options.writeAdminKey ?? writeAdminKeyFile;
  const read = options.readAdminKey ?? readAdminKeyFile;
  const remove = options.removeDirectory ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const description = credentialStoreDescription(platform);
  const encrypted = credentialStoreIsEncrypted(platform);
  const base = { platform, encrypted, description };

  let directory;
  let stage = "setup";
  try {
    const root = options.temporaryRoot ?? tmpdir();
    // realpath because macOS hands out /var/folders/... which is a symlink to
    // /private/var, and the store refuses a path that passes through a link.
    directory = realpathSync.native(mkdtempSync(join(root, "brain-store-probe-")));
    const path = join(directory, ".brain-admin-key");
    const storeOptions = { ...(options.storeOptions || {}), platform, username };

    stage = "write";
    write(path, CREDENTIAL_STORE_PROBE_VALUE, storeOptions);

    stage = "read";
    const readBack = read(path, storeOptions);

    stage = "compare";
    if (readBack !== CREDENTIAL_STORE_PROBE_VALUE) {
      return {
        ...base,
        ok: false,
        stage,
        error: "the store returned a different value than the one written",
      };
    }
    return { ...base, ok: true, stage: "compare", error: null };
  } catch (error) {
    return { ...base, ok: false, stage, error: messageOf(error) };
  } finally {
    if (directory) {
      try { remove(directory); } catch { /* a leftover probe directory is not worth failing over */ }
    }
  }
}
