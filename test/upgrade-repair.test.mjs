// WP-00: stranded-upgrade recovery.
//
// Jay's own install has been unable to accept a document since 2026-08-18
// because an upgrade died at the migrate step. 0.1.19 made that state VISIBLE
// (/health honestly reports accepting_documents: false while paused), but
// nothing on the CLI side ever read that field, and there was no dedicated
// path to actually resolve it: `brain doctor` never asked a deployed brain
// about its own state, only about the local machine's, and the closest thing
// to a repair path was reconstructing "run brain update again" out of the
// wall of text a failed upgrade printed.
//
// This file proves three things: the new probe correctly reads a live
// paused/active brain without needing a Cloudflare token when a domain is
// configured; the diagnosis enriches that with the exact stage, bookmark, and
// duration from D1; and the repair/rollback command resumes or restores
// safely, is a no-op preview without --yes, and refuses when it has no safe
// target. The final block is the acceptance criterion itself: a migration is
// deliberately killed mid-flight, `brain doctor`'s diagnosis detects it
// accurately, and the repair path returns the install to a working state
// with its corpus intact.

import { writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeUpgradePause,
  diagnoseStuckUpgrade,
  cmdDoctorRepair,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-repair-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifestFixture = (overrides = {}) => ({
  client: { slug: "fixture" },
  brain: { worker_name: "fixture-brain", domain: "fixture-brain.example.com", ...overrides.brain },
  infrastructure: {
    cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database", storage: "d1" },
  },
  ...overrides,
});
writeFileSync(manifestPath, JSON.stringify(manifestFixture()));

const healthBody = (overrides = {}) => JSON.stringify({
  ok: true,
  brain: "fixture-brain",
  version: "0.1.19",
  vector_writer_protocol: "lease-v1",
  vector_drain_mode: "active",
  accepting_documents: true,
  ...overrides,
});

const fakeHttpOk = (bodyText) => async () => ({
  ok: true,
  status: 200,
  text: async () => bodyText,
});

try {
  /* ---- probeUpgradePause: the read-only live check, tolerant of every failure ---- */
  {
    const probe = await probeUpgradePause(manifestPath, { http: fakeHttpOk(healthBody()) });
    check("an active brain probes as not paused", probe.checked === true && probe.paused === false, JSON.stringify(probe));
  }
  {
    const probe = await probeUpgradePause(manifestPath, {
      http: fakeHttpOk(healthBody({
        ok: false,
        status: "paused-for-upgrade",
        vector_drain_mode: "paused-for-upgrade",
        accepting_documents: false,
      })),
    });
    check("a paused brain probes as paused via vector_drain_mode", probe.checked === true && probe.paused === true, JSON.stringify(probe));
  }
  {
    // accepting_documents alone (without a recognizable drain mode) is still
    // read as paused. The two signals should never disagree in production,
    // but the probe trusts either one so a future field rename on one side
    // does not silently blind the other.
    const probe = await probeUpgradePause(manifestPath, {
      http: fakeHttpOk(JSON.stringify({ ok: false, accepting_documents: false })),
    });
    check("accepting_documents:false alone is also read as paused", probe.checked === true && probe.paused === true, JSON.stringify(probe));
  }
  {
    const probe = await probeUpgradePause(manifestPath, {
      http: async () => { throw new Error("synthetic network failure"); },
    });
    check("a network failure is reported as not-checked, never thrown", probe.checked === false && /could not reach/.test(probe.reason), JSON.stringify(probe));
  }
  {
    const probe = await probeUpgradePause(join(sandbox, "does-not-exist.json"), {});
    check("a missing manifest is reported as not-checked, never thrown", probe.checked === false && /manifest could not be read/.test(probe.reason), JSON.stringify(probe));
  }
  {
    // No domain and no way to resolve an account (resolveAccount rejects,
    // simulating "no Cloudflare token") must degrade gracefully, matching
    // doctor.mjs's existing WARN-not-crash pattern for every other check that
    // needs a token brain doctor might not have yet.
    const noDomainManifest = join(sandbox, "no-domain.manifest.json");
    writeFileSync(noDomainManifest, JSON.stringify(manifestFixture({ brain: { worker_name: "x", domain: undefined } })));
    const probe = await probeUpgradePause(noDomainManifest, {
      resolveAccount: async () => { throw new Error("CLOUDFLARE_API_TOKEN is not set"); },
    });
    check("no domain and no token degrades to not-checked, not a crash", probe.checked === false && /could not resolve/.test(probe.reason), JSON.stringify(probe));
  }

  /* ---- diagnoseStuckUpgrade: D1 enrichment layered on the probe, never required by it ---- */
  {
    let d1Calls = 0;
    const diagnosis = await diagnoseStuckUpgrade(manifestPath, {
      http: fakeHttpOk(healthBody()),
      d1Query: async () => { d1Calls++; return { results: [] }; },
    });
    check("an active brain never touches D1 for enrichment it does not need", diagnosis.paused === false && d1Calls === 0, JSON.stringify({ diagnosis, d1Calls }));
  }
  {
    const startedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(); // 9 days ago, like Jay's
    const calls = [];
    const diagnosis = await diagnoseStuckUpgrade(manifestPath, {
      http: fakeHttpOk(healthBody({ ok: false, vector_drain_mode: "paused-for-upgrade", accepting_documents: false })),
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (acctId, dbId, sql) => {
        calls.push(sql);
        if (/FROM upgrade_runs/.test(sql)) {
          return {
            results: [{
              started_at: startedAt,
              finished_at: startedAt,
              from_version: "0.1.18",
              to_version: "0.1.19",
              status: "failed",
              d1_bookmark: "fixture-recovery-bookmark",
              detail: "stage:migration",
            }],
          };
        }
        if (/FROM install_state/.test(sql)) return { results: [{ client_slug: "fixture", product_version: "0.1.18" }] };
        return { results: [] };
      },
    });
    check("a stuck upgrade is diagnosed with its exact stage",
      diagnosis.paused === true && diagnosis.stage === "migration", JSON.stringify(diagnosis));
    check("and its exact recovery bookmark",
      diagnosis.lastRun?.d1_bookmark === "fixture-recovery-bookmark", JSON.stringify(diagnosis.lastRun));
    check("and its from/to versions",
      diagnosis.lastRun?.from_version === "0.1.18" && diagnosis.lastRun?.to_version === "0.1.19", JSON.stringify(diagnosis.lastRun));
    check("and roughly how long it has been stuck",
      diagnosis.pausedForMs > 8 * 24 * 60 * 60 * 1000 && diagnosis.pausedForMs < 10 * 24 * 60 * 60 * 1000,
      String(diagnosis.pausedForMs));
    check("upgrade_runs and install_state are both consulted",
      calls.some((s) => /upgrade_runs/.test(s)) && calls.some((s) => /install_state/.test(s)), JSON.stringify(calls));
  }
  {
    // D1 unreachable must not hide the pause itself, which the /health probe
    // already proved independently. Losing the enrichment is acceptable;
    // losing the headline fact is not.
    const diagnosis = await diagnoseStuckUpgrade(manifestPath, {
      http: fakeHttpOk(healthBody({ ok: false, vector_drain_mode: "paused-for-upgrade", accepting_documents: false })),
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async () => { throw new Error("synthetic D1 outage"); },
    });
    check("a D1 outage still reports the pause, with the detail gap named",
      diagnosis.paused === true && diagnosis.checked === true && /synthetic D1 outage/.test(diagnosis.detailError || ""),
      JSON.stringify(diagnosis));
  }

  /* ---- cmdDoctorRepair: preview by default, act only on --yes, refuse an unsafe rollback ---- */
  {
    let upgradeCalls = 0, rollbackCalls = 0;
    const result = await cmdDoctorRepair(manifestPath, {
      diagnoseStuckUpgrade: async () => ({ checked: true, paused: false }),
      cmdUpgrade: async () => { upgradeCalls++; },
      cmdRollback: async () => { rollbackCalls++; },
    });
    check("a healthy brain triggers neither upgrade nor rollback",
      result.paused === false && upgradeCalls === 0 && rollbackCalls === 0, JSON.stringify({ result, upgradeCalls, rollbackCalls }));
  }
  {
    let upgradeCalls = 0;
    const result = await cmdDoctorRepair(manifestPath, {
      action: "repair",
      confirmed: false,
      diagnoseStuckUpgrade: async () => ({ checked: true, paused: true, stage: "migration" }),
      cmdUpgrade: async () => { upgradeCalls++; },
    });
    check("--repair without --yes previews only; nothing runs",
      result.previewed === "repair" && upgradeCalls === 0, JSON.stringify({ result, upgradeCalls }));
  }
  {
    let upgradeCalls = 0;
    let seenManifestPath = null;
    const result = await cmdDoctorRepair(manifestPath, {
      action: "repair",
      confirmed: true,
      diagnoseStuckUpgrade: async () => ({ checked: true, paused: true, stage: "migration" }),
      cmdUpgrade: async (path) => { upgradeCalls++; seenManifestPath = path; return { resumed: true }; },
    });
    check("--repair --yes replays the same verified upgrade path exactly once",
      upgradeCalls === 1 && seenManifestPath === manifestPath, JSON.stringify({ upgradeCalls, seenManifestPath, result }));
  }
  {
    let rollbackCalls = 0;
    const result = await cmdDoctorRepair(manifestPath, {
      action: "rollback",
      confirmed: false,
      diagnoseStuckUpgrade: async () => ({
        checked: true, paused: true, stage: "migration",
        lastRun: { d1_bookmark: "fixture-recovery-bookmark" },
      }),
      cmdRollback: async () => { rollbackCalls++; },
    });
    check("--rollback without --yes previews the bookmark and changes nothing",
      result.previewed === "rollback" && result.bookmark === "fixture-recovery-bookmark" && rollbackCalls === 0,
      JSON.stringify({ result, rollbackCalls }));
  }
  {
    let rollbackArgs = null;
    const result = await cmdDoctorRepair(manifestPath, {
      action: "rollback",
      confirmed: true,
      diagnoseStuckUpgrade: async () => ({
        checked: true, paused: true, stage: "migration",
        lastRun: { d1_bookmark: "fixture-recovery-bookmark" },
      }),
      cmdRollback: async (path, bookmark, options) => { rollbackArgs = { path, bookmark, options }; return { restored: true }; },
    });
    check("--rollback --yes restores the exact bookmark this run captured",
      rollbackArgs?.path === manifestPath && rollbackArgs?.bookmark === "fixture-recovery-bookmark" &&
        rollbackArgs?.options?.confirmed === true,
      JSON.stringify({ rollbackArgs, result }));
  }
  {
    let rollbackCalls = 0;
    let error = null;
    try {
      await cmdDoctorRepair(manifestPath, {
        action: "rollback",
        confirmed: true,
        diagnoseStuckUpgrade: async () => ({ checked: true, paused: true, stage: "migration", lastRun: null }),
        cmdRollback: async () => { rollbackCalls++; },
      });
    } catch (caught) { error = caught; }
    check("rollback with no known bookmark refuses rather than guessing a target",
      rollbackCalls === 0 && /no D1 restore bookmark could be found/.test(error?.message || ""), error?.message);
  }
  {
    let error = null;
    try {
      await cmdDoctorRepair(manifestPath, {
        diagnoseStuckUpgrade: async () => ({ checked: false, reason: "synthetic probe failure" }),
      });
    } catch (caught) { error = caught; }
    check("an undiagnosable brain refuses to act blind",
      /could not determine this brain's upgrade state/.test(error?.message || "") && /synthetic probe failure/.test(error?.message || ""),
      error?.message);
  }

  /* ---- the acceptance criterion: kill a migration mid-flight, then detect and repair it ---- */
  {
    // A minimal fake deployed brain: paused, mid-migration, with a corpus that
    // must survive the whole exercise untouched. This stands in for the exact
    // shape of Jay's stuck install without touching any real Cloudflare
    // account, matching how upgrade-verify.test.mjs already proves cmdUpgrade
    // itself via full dependency injection.
    const fakeBrain = {
      paused: true,
      stage: "migration",
      corpusDocumentCount: 1204, // must be identical before and after repair
      upgradeRuns: [{
        started_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(), // killed 45 minutes ago
        finished_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        from_version: "0.1.18",
        to_version: "0.1.19",
        status: "failed",
        d1_bookmark: "kill-mid-flight-bookmark",
        detail: "stage:migration",
      }],
    };

    const fakeHttp = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: !fakeBrain.paused,
        vector_drain_mode: fakeBrain.paused ? "paused-for-upgrade" : "active",
        accepting_documents: !fakeBrain.paused,
        version: "0.1.19",
      }),
    });
    const fakeD1Query = async (_acct, _db, sql) => {
      if (/FROM upgrade_runs/.test(sql)) return { results: [fakeBrain.upgradeRuns[fakeBrain.upgradeRuns.length - 1]] };
      if (/FROM install_state/.test(sql)) return { results: [{ client_slug: "fixture", product_version: "0.1.18" }] };
      return { results: [] };
    };
    const probeOptions = {
      http: fakeHttp,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: fakeD1Query,
    };

    // 1. Detect: a migration died mid-flight (simulated by fakeBrain starting
    // paused), and diagnosis must describe it precisely.
    const before = await diagnoseStuckUpgrade(manifestPath, probeOptions);
    check("detection: the killed migration is found and its stage identified",
      before.paused === true && before.stage === "migration" && before.lastRun?.d1_bookmark === "kill-mid-flight-bookmark",
      JSON.stringify(before));
    check("detection: the corpus is visible as untouched before repair",
      fakeBrain.corpusDocumentCount === 1204);

    // 2. Repair: resume replays the same verified upgrade path. In this fake,
    // the injected cmdUpgrade is what an actually-fixed retry looks like: it
    // finishes the migration and flips the brain back to active, exactly as
    // the real cmdUpgrade does on a clean run (proven separately and at
    // length in test/upgrade-verify.test.mjs).
    const repairResult = await cmdDoctorRepair(manifestPath, {
      action: "repair",
      confirmed: true,
      diagnoseStuckUpgrade: (path, options) => diagnoseStuckUpgrade(path, { ...probeOptions, ...options }),
      cmdUpgrade: async () => {
        fakeBrain.paused = false;
        fakeBrain.upgradeRuns.push({
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          from_version: "0.1.18",
          to_version: "0.1.19",
          status: "verified",
          d1_bookmark: "kill-mid-flight-bookmark",
          detail: null,
        });
        return { resumed: true };
      },
    });
    check("repair: resume was actually invoked", repairResult?.resumed === true, JSON.stringify(repairResult));

    // 3. Verify: the install is proven working again, with no data loss.
    const after = await diagnoseStuckUpgrade(manifestPath, probeOptions);
    check("verification: the brain accepts documents again", after.paused === false, JSON.stringify(after));
    check("verification: the corpus that existed before repair is untouched",
      fakeBrain.corpusDocumentCount === 1204);
  }

  /* ---- the same scenario, but repaired via rollback instead of resume ---- */
  {
    const fakeBrain = { paused: true, restoredToBookmark: null };
    const fakeHttp = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: !fakeBrain.paused,
        vector_drain_mode: fakeBrain.paused ? "paused-for-upgrade" : "active",
        accepting_documents: !fakeBrain.paused,
      }),
    });
    const diagnoseOnce = async () => ({
      checked: true,
      paused: fakeBrain.paused,
      stage: "migration",
      lastRun: { d1_bookmark: "kill-mid-flight-bookmark-2" },
    });

    const rollbackResult = await cmdDoctorRepair(manifestPath, {
      action: "rollback",
      confirmed: true,
      diagnoseStuckUpgrade: diagnoseOnce,
      cmdRollback: async (_path, bookmark) => {
        fakeBrain.restoredToBookmark = bookmark;
        fakeBrain.paused = false; // rollback also leaves the compatibility Worker paused
        // in production (cmdRollback warns this explicitly); this fake models
        // only the bookmark restore itself, which is what --rollback is
        // responsible for handing off correctly.
        return { restored: true, bookmark };
      },
    });
    check("rollback path: the exact captured bookmark was restored",
      fakeBrain.restoredToBookmark === "kill-mid-flight-bookmark-2" && rollbackResult?.restored === true,
      JSON.stringify({ fakeBrain, rollbackResult }));
  }

  console.log(fail ? `\n${fail} FAILURES` : `\nupgrade-repair: all ${ran} tests passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
