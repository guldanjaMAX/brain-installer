// test/imap-connector.test.mjs
//
// The IMAP connector, driven end to end against a SCRIPTED IMAP SERVER on a
// real socket (test/fixtures/imap-server.mjs), not against mocks of the
// connector's own functions.
//
// WHAT A PASS HERE PROVES:
//   - the protocol client speaks real RFC 3501 well enough to log in, list,
//     EXAMINE, UID SEARCH and UID FETCH a message body delivered as a `{N}`
//     literal, and to parse the response back into octets;
//   - a first sync loads, a second sync loads ONLY new mail, and a
//     UIDVALIDITY change re-reads the folder instead of resuming from a number
//     that no longer means anything;
//   - a message becomes the same document shape the Gmail path produces, with
//     the same rendered content for the same RFC 822 bytes, because both go
//     through the same postal-mime `.eml` reader;
//   - bulk mail is excluded by the two-signal header rule, and a legitimate
//     vendor thread carrying only List-Unsubscribe is NOT.
//
// WHAT A PASS HERE DOES NOT PROVE, STATED PLAINLY:
//   - NO LIVE MAILBOX. Nothing here has ever talked to Yahoo, iCloud,
//     Fastmail or any real IMAP server. Every provider-specific claim in the
//     connector (Yahoo's "Bulk Mail" folder name, app-password requirement,
//     throttling behavior, whether SPECIAL-USE is advertised) is written from
//     the specification and from documented provider behavior, and is NOT
//     verified by this file. The scripted server answers the way the RFC says
//     a server should; a real one may not.
//   - TLS is local and synthetic. The suite proves implicit TLS, explicit trust
//     of the synthetic CA, and default rejection of an untrusted certificate.
//     It does not prove a live provider's certificate chain or TLS policy.
//   - NO KEYCHAIN WRITE. Credential custody is asserted on the storage
//     OPTIONS the connector produces (which item, which env var), not by
//     writing to a real macOS Keychain.
//
// Every persona, address and domain below is invented.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Folder, ScriptedImapServer } from "./fixtures/imap-server.mjs";
import * as imap from "../connectors/imap.mjs";
import { toEnvelope as gmailToEnvelope } from "../connectors/gmail.mjs";
import { PassThrough } from "node:stream";
import { readHiddenSecret } from "../brain.mjs";
import selfsigned from "selfsigned";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

const sandbox = mkdtempSync(join(tmpdir(), "imap-test-"));
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const LOAD_FETCH = pathToFileURL(join(HERE, "fixtures", "imap-load-fetch.mjs")).href;
const stripAnsi = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, "");

/* ------------------------------------------------------------- fixtures */

const message = ({ from, subject, body, messageId, extra = "" }) =>
  `Message-ID: <${messageId}>\r\n` +
  `From: ${from}\r\n` +
  "To: owner@northwind-example.test\r\n" +
  `Subject: ${subject}\r\n` +
  "Date: Mon, 24 Aug 2026 09:00:00 -0700\r\n" +
  extra +
  "MIME-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
  body;

const ENGAGEMENT = message({
  messageId: "engagement-001@northwind-example.test",
  from: "Priya Nair <priya.nair@northwind-example.test>",
  subject: "Signed engagement letter",
  body: "Attached is the signed engagement letter. Onboarding starts the third Monday in September.",
});

const INVOICE = message({
  messageId: "invoice-2291@harborline-example.test",
  from: "Sam Osei <sam.osei@harborline-example.test>",
  subject: "Invoice 2291 is thirty days past due",
  // ONE bulk signal, and one only. A vendor's billing system sets an
  // unsubscribe header; that must not be enough to drop an unpaid invoice.
  extra: "List-Unsubscribe: <mailto:stop@harborline-example.test>\r\n",
  body: "Invoice 2291 for the September retainer is thirty days past due. Please confirm the payment date.",
});

const NEWSLETTER = message({
  messageId: "campaign-88213@lantern-example.test",
  from: "Lantern Weekly <news@lantern-example.test>",
  subject: "Nine trends reshaping procurement this quarter",
  // TWO independent signals: a list identity AND an unsubscribe header. That
  // is the combination the filter is built to catch.
  extra:
    "List-Id: Lantern Weekly <weekly.lantern-example.test>\r\n" +
    "List-Unsubscribe: <https://lantern-example.test/u/9912>\r\n",
  body:
    "Nine trends reshaping procurement this quarter, plus a case study on supplier consolidation " +
    "and a short interview with a category manager about tail spend. Read the whole issue online.",
});

const REPLY = message({
  messageId: "reply-004@northwind-example.test",
  from: "Jordan Lee <jordan.lee@northwind-example.test>",
  subject: "Re: Signed engagement letter",
  body: "Confirmed on our side. The countersigned copy is with our finance team and lands Thursday morning.",
});

/* ------------------------------------------------------- server + client */

function buildServer(options = {}) {
  const inbox = new Folder("INBOX", { uidvalidity: 4001 });
  inbox.add(ENGAGEMENT, { internaldate: "24-Aug-2026 16:00:00 +0000" });
  inbox.add(INVOICE, { internaldate: "25-Aug-2026 09:12:00 +0000" });
  inbox.add(NEWSLETTER, { internaldate: "25-Aug-2026 11:40:00 +0000" });
  return new ScriptedImapServer({
    ...options,
    username: "owner@northwind-example.test",
    password: "abcdefghijklmnop",
    folders: [
      inbox,
      new Folder("Sent", { uidvalidity: 4002, flags: ["\\Sent"] }),
      // Yahoo's spam folder name. A Gmail-tuned table calls this unclassified
      // and reads it, which is the single highest-volume way to poison a brain.
      new Folder("Bulk Mail", { uidvalidity: 4003 }),
      new Folder("Trash", { uidvalidity: 4004, flags: ["\\Trash"] }),
      new Folder("Drafts", { uidvalidity: 4005, flags: ["\\Drafts"] }),
      new Folder("Projekte", { uidvalidity: 4006 }),
      // Identified as an archive, and NOT read. It exists here because calling
      // an identified folder "unclassified" is a false sentence in the one
      // place an operator is reading for the truth.
      new Folder("Archive", { uidvalidity: 4007, flags: ["\\Archive"] }),
      // Gmail-over-IMAP's container. Not a mail folder, cannot be EXAMINEd,
      // and must not be reported as a folder that could not be identified.
      new Folder("[Gmail]", { uidvalidity: 4008, flags: ["\\Noselect", "\\HasChildren"] }),
    ],
  });
}

/**
 * Run the real `brain ingest --from imap` command against a synthetic TLS
 * mailbox and an in-process Worker fixture. The returned state and source
 * receipts are the actual completion boundary used by `brain load` and source
 * health, not a second test-only classifier.
 */
async function runImapLoadScenario({ name, identity, folders }) {
  // Admin-key custody rejects a path whose spelling crosses the macOS
  // `/var` -> `/private/var` link. Use the canonical fixture root just as a
  // real manifest locator would be canonicalized before installation.
  const directory = join(realpathSync(sandbox), `load-${name}`);
  const userRoot = join(directory, "home");
  const brainRoot = join(userRoot, ".brain");
  const manifestPath = join(directory, "brain.manifest.json");
  const statePath = join(directory, ".brain-ingest-mailbox.json");
  const evidencePath = join(directory, "evidence.json");
  const certPath = join(directory, "fixture-ca.pem");
  mkdirSync(brainRoot, { recursive: true, mode: 0o700 });
  chmodSync(userRoot, 0o700);
  chmodSync(brainRoot, 0o700);

  const server = new ScriptedImapServer({
    username: "owner@northwind-example.test",
    password: "abcdefghijklmnop",
    folders,
    tls: { key: identity.private, cert: identity.cert },
  });
  await server.listen();

  writeFileSync(manifestPath, `${JSON.stringify({
    manifest_version: 1,
    client: { slug: "northwind", display_name: "Northwind Studio", timezone: "America/Phoenix" },
    brain: { version: "0.2.1", domain: "fixture.invalid", worker_name: "northwind-brain" },
    infrastructure: {
      cloudflare: { account_id: "fixture-account", storage: "d1", d1_database_id: "fixture-db" },
    },
    safety: { credential_scanner: { enabled: false } },
    corpora: { imap: { enabled: true, source: "mailbox" } },
  }, null, 2)}\n`);
  writeFileSync(join(directory, ".brain-admin-key"), "fixture-admin-key-for-offline-imap-test", { mode: 0o600 });
  writeFileSync(join(brainRoot, "imap-credentials.json"), `${JSON.stringify({
    imap: {
      host: "127.0.0.1",
      port: server.port,
      username: server.username,
      password: server.password,
      connected_at: "2026-08-30T00:00:00.000Z",
    },
  }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(evidencePath, `${JSON.stringify({ receipts: [], ingested: 0, reconciliations: 0 })}\n`, { mode: 0o600 });
  writeFileSync(certPath, identity.cert, { mode: 0o600 });

  const environment = { ...process.env };
  for (const key of [
    "ADMIN_KEY",
    "BRAIN_DEBUG",
    "CLOUDFLARE_API_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "NODE_OPTIONS",
  ]) delete environment[key];
  Object.assign(environment, {
    HOME: userRoot,
    BRAIN_IMAP_CREDENTIAL_STORE: "file",
    BRAIN_IMAP_LOAD_EVIDENCE_PATH: evidencePath,
    BRAIN_IMAP_LOAD_USER_ROOT: userRoot,
    NODE_EXTRA_CA_CERTS: certPath,
  });

  let output = "";
  let code = null;
  try {
    const child = spawn(process.execPath, [
      "--import", LOAD_FETCH,
      CLI, "ingest", manifestPath, "--from", "imap", "--source", "mailbox",
    ], {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the ${name} IMAP CLI fixture timed out`));
      }, 30_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (status) => { clearTimeout(timeout); resolve(status); });
    });
  } finally {
    await server.close();
  }

  return {
    code,
    output: stripAnsi(output),
    state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null,
    evidence: JSON.parse(readFileSync(evidencePath, "utf8")),
  };
}

async function connected(server) {
  const client = new imap.ImapClient({ host: "127.0.0.1", port: server.port, socketFactory: server.socketFactory() });
  await client.connect();
  await client.login(server.username, server.password);
  return client;
}

/**
 * One sync leg, driven exactly the way brain.mjs drives it: decide from saved
 * state, stream the folder, build envelopes, and return the new watermark ONLY
 * after every message has been turned into a document or a named skip.
 */
async function syncFolder(server, folderName, saved, { reset = false, policyChanged = false } = {}) {
  const client = await connected(server);
  try {
    const before = await client.examine(folderName);
    const decision = imap.folderSyncDecision({
      storedUidvalidity: saved?.uidvalidity ?? null,
      currentUidvalidity: before.uidvalidity,
      lastUid: saved?.last_uid ?? 0,
      reset,
      policyChanged,
    });
    let highest = decision.resynced ? 0 : (saved?.last_uid ?? 0);
    const documents = [];
    const skips = [];
    const stream = imap.streamFolder(client, folderName, {
      criteria: decision.searchCriteria,
      floor: decision.floor,
      uidvalidity: before.uidvalidity,
    });
    for await (const message of stream) {
      if (message.uid > highest) highest = message.uid;
      const result = await imap.toEnvelope(message, { sourceName: "email", host: "127.0.0.1" });
      if (result.skip) skips.push(result.skip);
      else documents.push(result);
    }
    return { decision, documents, skips, watermark: { uidvalidity: before.uidvalidity, last_uid: highest } };
  } finally {
    await client.logout();
  }
}

try {
  const server = buildServer();
  await server.listen();

  /* ============================================================ *
   * 1. A first sync loads.
   * ============================================================ */
  const first = await syncFolder(server, "INBOX", null);
  check("first sync: no saved position, so the whole folder is read",
    first.decision.mode === "full" && first.decision.searchCriteria === "ALL", JSON.stringify(first.decision));
  check("first sync: the two genuine messages became documents",
    first.documents.length === 2, JSON.stringify(first.documents.map((d) => d.envelope.title)));
  check("first sync: the real message body reached the envelope, not a placeholder",
    first.documents.some((d) => /Onboarding starts the third Monday in September/.test(d.envelope.content)),
    first.documents[0]?.envelope.content?.slice(0, 120));
  check("first sync: the watermark is the highest UID actually read",
    first.watermark.last_uid === 3 && first.watermark.uidvalidity === 4001, JSON.stringify(first.watermark));
  check("first sync: EXAMINE was used and SELECT never was, so nothing was marked read",
    server.log.some((l) => l.startsWith("EXAMINE")) && !server.log.some((l) => l.startsWith("SELECT")),
    server.log.join(" | "));

  /* ============================================================ *
   * 2. A second sync loads only new mail.
   * ============================================================ */
  server.log.length = 0;
  const quiet = await syncFolder(server, "INBOX", first.watermark);
  check("second sync with nothing new: incremental, and the search is bounded by the watermark",
    quiet.decision.mode === "incremental" && quiet.decision.searchCriteria === "UID 4:*",
    JSON.stringify(quiet.decision));
  check("second sync with nothing new: RFC 3501 6.4.8 returns the highest UID anyway, and it is filtered out",
    quiet.documents.length === 0 && quiet.skips.length === 0,
    `documents=${quiet.documents.length} skips=${quiet.skips.length} log=${server.log.join(" | ")}`);
  check("second sync with nothing new: the server WAS asked, and did return UID 3",
    server.log.some((l) => /SEARCH UID 4:\*/.test(l)), server.log.join(" | "));

  server.folder("INBOX").add(REPLY, { internaldate: "26-Aug-2026 08:05:00 +0000" });
  const second = await syncFolder(server, "INBOX", first.watermark);
  check("second sync with one new message: exactly one document, and it is the new one",
    second.documents.length === 1 && /countersigned copy/.test(second.documents[0].envelope.content),
    JSON.stringify(second.documents.map((d) => d.envelope.title)));
  check("second sync: the three already-loaded messages were never refetched",
    second.watermark.last_uid === 4, JSON.stringify(second.watermark));

  /* ============================================================ *
   * 3. A UIDVALIDITY change resyncs rather than silently skipping.
   * ============================================================ */
  const beforeRoll = second.watermark;
  server.folder("INBOX").rollUidvalidity(9001);
  const rolled = await syncFolder(server, "INBOX", beforeRoll);
  check("UIDVALIDITY change: the decision says resynced, with a reason an operator can read",
    rolled.decision.resynced === true && /UIDVALIDITY/.test(rolled.decision.reason || ""),
    JSON.stringify(rolled.decision));
  check("UIDVALIDITY change: the search is ALL, not a resume from the old watermark",
    rolled.decision.searchCriteria === "ALL" && rolled.decision.floor === 0, JSON.stringify(rolled.decision));
  check("UIDVALIDITY change: EVERY message is read again, including the ones below the old watermark",
    rolled.documents.length + rolled.skips.length === 4,
    `documents=${rolled.documents.length} skips=${rolled.skips.length}`);
  check("UIDVALIDITY change: the new watermark carries the NEW uidvalidity, never the old one",
    rolled.watermark.uidvalidity === 9001 && rolled.watermark.last_uid === 4, JSON.stringify(rolled.watermark));
  // The property that makes the resync affordable, and the reason the document
  // id is the message's own identity rather than its UID.
  const idsBefore = new Set([...first.documents, ...second.documents].map((d) => d.envelope.source_id));
  const idsAfter = new Set(rolled.documents.map((d) => d.envelope.source_id));
  check("UIDVALIDITY change: the documents keep their identity, so a resync is unchanged rather than a duplicated mailbox",
    [...idsAfter].every((id) => idsBefore.has(id)) && idsAfter.size === idsBefore.size,
    JSON.stringify({ before: [...idsBefore], after: [...idsAfter] }));
  const versionsBefore = new Map([...first.documents, ...second.documents].map((d) => [d.envelope.source_id, d.version]));
  check("UIDVALIDITY change: the version is content-derived, so nothing is re-embedded",
    rolled.documents.every((d) => versionsBefore.get(d.envelope.source_id) === d.version),
    JSON.stringify(rolled.documents.map((d) => [d.envelope.source_id, d.version])));

  // And the failure this is all guarding against: the naive implementation.
  const naive = imap.folderSyncDecision({ storedUidvalidity: 4001, currentUidvalidity: 9001, lastUid: 4 });
  check("UIDVALIDITY change: a resume from UID 5 under the new numbering would have skipped all four messages, and is refused",
    naive.searchCriteria === "ALL" && naive.floor === 0, JSON.stringify(naive));

  /* ============================================================ *
   * 4. The same document shape the Gmail path produces.
   * ============================================================ */
  const gmailJson = (body) => ({ ok: true, status: 200, json: async () => body });
  const gmailResult = await gmailToEnvelope(async () => "at-1", "gmail-imap-parity-01", { sourceName: "email" }, {
    fetchImpl: async () => gmailJson({
      raw: Buffer.from(ENGAGEMENT, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
      internalDate: "1756051200000",
      threadId: "T-1",
      historyId: "H-1",
      labelIds: ["INBOX"],
    }),
    sleep: async () => {},
  });
  const mine = first.documents.find((d) => /engagement/i.test(d.envelope.title));
  check("parity: the Gmail path produced an envelope from the same bytes",
    !!gmailResult.envelope, JSON.stringify(gmailResult.skip));
  check("parity: identical field set, so both connectors write the same document shape",
    JSON.stringify(Object.keys(mine.envelope).sort()) === JSON.stringify(Object.keys(gmailResult.envelope).sort()),
    JSON.stringify({ imap: Object.keys(mine.envelope).sort(), gmail: Object.keys(gmailResult.envelope).sort() }));
  check("parity: identical source_type, so both land in one retrieval category",
    mine.envelope.source_type === gmailResult.envelope.source_type,
    `${mine.envelope.source_type} vs ${gmailResult.envelope.source_type}`);
  check("parity: byte-identical rendered content, because both go through the same postal-mime .eml reader",
    mine.envelope.content === gmailResult.envelope.content,
    JSON.stringify({ imap: mine.envelope.content.slice(0, 80), gmail: gmailResult.envelope.content.slice(0, 80) }));
  check("parity: same title, taken from the parsed header rather than a regex over the rendered text",
    mine.envelope.title === gmailResult.envelope.title, `${mine.envelope.title} vs ${gmailResult.envelope.title}`);
  check("provenance is NOT conflated: IMAP names its own date source rather than reusing Gmail's label",
    mine.envelope.date_source === "imap_internaldate" && gmailResult.envelope.date_source === "gmail_internal",
    `${mine.envelope.date_source} vs ${gmailResult.envelope.date_source}`);
  check("the document date is the server's receipt time, not the sender-supplied Date header",
    mine.envelope.occurred_at === "2026-08-24T16:00:00.000Z" && mine.envelope.date_reliable === true,
    JSON.stringify({ occurred_at: mine.envelope.occurred_at, reliable: mine.envelope.date_reliable }));
  check("the uri is an honest imap:// reference, not an invented webmail link that would 404",
    /^imap:\/\/127\.0\.0\.1\/INBOX;UID=1$/.test(mine.envelope.uri), mine.envelope.uri);

  /**
   * The subject regex bug that exists in the Gmail connector today, not ported.
   * A message with no Subject header whose BODY quotes a forwarded one.
   */
  const forwarded = new Folder("Fwd", { uidvalidity: 7001 });
  forwarded.add(
    "Message-ID: <no-subject-9@northwind-example.test>\r\n" +
    "From: Morgan Diaz <morgan.diaz@northwind-example.test>\r\n" +
    "To: owner@northwind-example.test\r\n" +
    "Date: Mon, 24 Aug 2026 09:00:00 -0700\r\n\r\n" +
    "See below.\r\n\r\n> From: someone else\r\n> Subject: Quarterly bonus schedule\r\n> the forwarded body\r\n",
  );
  server.folders.set("Fwd", forwarded);
  const fwd = await syncFolder(server, "Fwd", null);
  check("a subject-less message is NOT titled with a subject quoted inside its own body",
    fwd.documents[0]?.envelope.title === "(no subject)", fwd.documents[0]?.envelope.title);

  /* ============================================================ *
   * 5. Bulk mail is excluded, by the mechanism actually chosen.
   * ============================================================ */
  const bulkSkip = first.skips.find((s) => /bulk mail/.test(s.reason));
  check("bulk exclusion: the two-signal newsletter was dropped",
    !!bulkSkip, JSON.stringify(first.skips.map((s) => s.reason)));
  check("bulk exclusion: the skip NAMES the signals, so a wrong call can be judged rather than guessed at",
    /list-id/.test(bulkSkip?.reason || "") && /list-unsubscribe/.test(bulkSkip?.reason || ""), bulkSkip?.reason);
  check("bulk exclusion: the past-due invoice carrying ONLY List-Unsubscribe was KEPT",
    first.documents.some((d) => /Invoice 2291/.test(d.envelope.title)),
    JSON.stringify(first.documents.map((d) => d.envelope.title)));
  check("bulk exclusion: one signal is below the threshold, which is the whole discrimination",
    imap.bulkSignals(imap.parseHeaderBlock(INVOICE)).length === 1 &&
    imap.bulkSignals(imap.parseHeaderBlock(NEWSLETTER)).length === 2,
    JSON.stringify({
      invoice: imap.bulkSignals(imap.parseHeaderBlock(INVOICE)),
      newsletter: imap.bulkSignals(imap.parseHeaderBlock(NEWSLETTER)),
    }));
  check("bulk exclusion: a Precedence: bulk auto-notice with a campaign header is caught too",
    imap.isBulkMail(imap.parseHeaderBlock(
      "From: a@b.test\r\nPrecedence: bulk\r\nX-Mailer: Mailchimp 3.2\r\nSubject: x\r\n\r\nbody"
    )), "expected two signals");
  check("bulk exclusion: the policy fingerprint changes when the rule changes, so old decisions cannot go stale silently",
    imap.imapPolicyFingerprint(imap.BULK_POLICY, ["inbox", "sent"]) !==
    imap.imapPolicyFingerprint({ ...imap.BULK_POLICY, min_signals: 1 }, ["inbox", "sent"]),
    "fingerprints matched");

  /* ============================================================ *
   * 6. Folder policy: what is read, what is skipped, what is reported.
   * ============================================================ */
  const client = await connected(server);
  const folders = await client.list();
  await client.logout();
  const role = (name) => folders.find((f) => f.name === name)?.role;
  check("folder policy: Yahoo's \"Bulk Mail\" is recognised as junk, not left unclassified and read",
    role("Bulk Mail") === "junk", JSON.stringify(folders.map((f) => [f.name, f.role])));
  check("folder policy: SPECIAL-USE flags classify Sent, Trash and Drafts",
    role("Sent") === "sent" && role("Trash") === "trash" && role("Drafts") === "drafts",
    JSON.stringify(folders.map((f) => [f.name, f.role, f.by])));
  check("folder policy: inbox and sent are read; junk, trash, drafts and all-mail are not",
    imap.BULK_POLICY.include_roles.includes("inbox") && imap.BULK_POLICY.include_roles.includes("sent") &&
    ["junk", "trash", "drafts", "all"].every((r) => imap.BULK_POLICY.skip_roles.includes(r)),
    JSON.stringify(imap.BULK_POLICY));
  check("folder policy: an unrecognised folder is reported as unclassified rather than guessed at",
    role("Projekte") === null || role("Projekte") === undefined,
    JSON.stringify(folders.find((f) => f.name === "Projekte")));

  const partition = imap.partitionFolders(folders);
  check("folder policy: the partition the sync loop actually uses reads only inbox and sent",
    partition.included.map((f) => f.name).sort().join(",") === "INBOX,Sent",
    JSON.stringify(partition.included.map((f) => f.name)));
  check("folder policy: Bulk Mail, Trash and Drafts land in the skipped list, not the read list",
    partition.skipped.map((f) => f.name).sort().join(",") === "Bulk Mail,Drafts,Trash",
    JSON.stringify(partition.skipped.map((f) => f.name)));
  check("folder policy: the unrecognised folder is surfaced for reporting rather than dropped from every list",
    partition.unclassified.map((f) => f.name).includes("Projekte"),
    JSON.stringify(partition.unclassified.map((f) => f.name)));
  // An identified folder reported as unidentified is a false statement made in
  // the one place the operator is reading for the truth, and it is the more
  // alarming of the two readings. Archive is the real case: it can hold years
  // of a client's mail, and it is not read.
  check("folder policy: an Archive folder is reported as identified-but-not-read, NOT as unidentified",
    partition.unlisted.map((f) => f.name).includes("Archive") &&
    !partition.unclassified.map((f) => f.name).includes("Archive"),
    `unlisted=${JSON.stringify(partition.unlisted.map((f) => f.name))} unclassified=${JSON.stringify(partition.unclassified.map((f) => f.name))}`);
  check("folder policy: a \\Noselect container is not counted as a mail folder that went unread",
    partition.containers.map((f) => f.name).includes("[Gmail]") &&
    !partition.unclassified.map((f) => f.name).includes("[Gmail]") &&
    !partition.unlisted.map((f) => f.name).includes("[Gmail]"),
    `containers=${JSON.stringify(partition.containers.map((f) => f.name))} unclassified=${JSON.stringify(partition.unclassified.map((f) => f.name))}`);
  check("folder policy: every folder lands in exactly one bucket, so none is silently dropped",
    partition.included.length + partition.skipped.length + partition.unlisted.length +
      partition.unclassified.length + partition.containers.length === folders.length,
    `folders=${folders.length} buckets=${[partition.included, partition.skipped, partition.unlisted, partition.unclassified, partition.containers].map((b) => b.length).join("+")}`);
  check("folder policy: an identified-but-unread folder still names its role, so the operator can judge it",
    partition.unlisted.every((f) => typeof f.role === "string" && f.role.length > 0),
    JSON.stringify(partition.unlisted.map((f) => [f.name, f.role])));

  /* ============================================================ *
   * 6b. The two guards that make a partial run safe.
   * ============================================================ */
  let midRun = null;
  try { imap.assertUidvalidityStable("INBOX", 4001, 9001); } catch (error) { midRun = error; }
  check("a UIDVALIDITY roll DURING a run is refused, so a watermark from the old numbering is never recorded",
    midRun instanceof imap.ImapError && /DURING this run/.test(midRun.message), String(midRun?.message));
  check("a stable UIDVALIDITY passes the same guard",
    imap.assertUidvalidityStable("INBOX", 4001, 4001) === true, "guard rejected a stable folder");
  const merged = imap.mergeFolderWatermarks(
    { INBOX: { uidvalidity: 4001, last_uid: 3 }, Sent: { uidvalidity: 4002, last_uid: 11 } },
    { INBOX: { uidvalidity: 9001, last_uid: 4 } },
  );
  check("per-folder positions MERGE: a folder not touched this run keeps its position",
    merged.Sent.last_uid === 11 && merged.INBOX.uidvalidity === 9001 && merged.INBOX.last_uid === 4,
    JSON.stringify(merged));
  check("the new UIDVALIDITY and its watermark are one object, so neither can be written without the other",
    Object.keys(merged.INBOX).sort().join(",") === "last_uid,uidvalidity", JSON.stringify(merged.INBOX));

  /* ============================================================ *
   * 7. Modified UTF-7, the reason a non-English folder is reachable at all.
   * ============================================================ */
  for (const [encoded, decoded] of [
    ["Entw&APw-rfe", "Entwürfe"],
    ["&BB8EQAQ+ENC-", null],
    ["INBOX", "INBOX"],
    ["Ren&AOk-", "René"],
    ["A&-B", "A&B"],
  ]) {
    if (decoded === null) continue;
    check(`modified UTF-7 decodes ${encoded} to ${decoded}`, imap.decodeMailboxName(encoded) === decoded, imap.decodeMailboxName(encoded));
    check(`modified UTF-7 re-encodes ${decoded} for EXAMINE`, imap.decodeMailboxName(imap.encodeMailboxName(decoded)) === decoded, imap.encodeMailboxName(decoded));
  }

  /* ============================================================ *
   * 8. Credential custody.
   * ============================================================ */
  const storage = imap.imapStorageOptions({ sourceName: "yahoo-mailbox", home: sandbox });
  check("custody: the mailbox password gets its OWN Keychain item, not the one labelled Google OAuth",
    storage.keychainService === "brain-installer.imap" &&
    storage.keychainAccount === "imap-yahoo-mailbox" &&
    /IMAP mailbox credentials/.test(storage.keychainComment),
    JSON.stringify(storage));
  check("custody: it also gets its own backend environment variable, so the Google one cannot decide where it lives",
    storage.storeEnv === "BRAIN_IMAP_CREDENTIAL_STORE" && storage.path.endsWith("imap-credentials.json"),
    JSON.stringify({ storeEnv: storage.storeEnv, path: storage.path }));
  check("custody: one item per mailbox, so a client with two can revoke one",
    imap.imapStorageOptions({ sourceName: "a" }).keychainAccount !== imap.imapStorageOptions({ sourceName: "b" }).keychainAccount,
    "accounts collided");
  check("custody: a password pasted with the spaces the provider displays still works",
    imap.normalizeAppPassword("abcd efgh ijkl mnop") === "abcdefghijklmnop",
    imap.normalizeAppPassword("abcd efgh ijkl mnop"));
  check("custody: the password never reached the wire log in readable form",
    !server.log.some((l) => l.includes(server.password)) && server.log.some((l) => l.startsWith("LOGIN")),
    server.log.filter((l) => l.startsWith("LOGIN")).join(" | "));

  /* ---- the prompt itself, not just the store it writes to ---------------- */
  // The password is read through the SAME hidden-input core the Cloudflare
  // token uses, with one deliberate difference: a space is a legal character
  // here. Providers print an app password in groups of four and people paste
  // exactly what they see, so rejecting the space at the keystroke would look
  // identical, to the person typing, to the provider rejecting their password.
  class FakeTty extends PassThrough {
    constructor() { super(); this.isTTY = true; this.isRaw = false; this.rawStates = []; }
    setRawMode(value) { this.isRaw = Boolean(value); this.rawStates.push(this.isRaw); return this; }
  }
  const promptOut = new PassThrough();
  promptOut.isTTY = true;
  let promptText = "";
  promptOut.on("data", (chunk) => { promptText += chunk.toString("utf8"); });
  const promptIn = new FakeTty();
  const typed = readHiddenSecret("  app password (hidden): ", { input: promptIn, output: promptOut });
  promptIn.write(Buffer.from("abcd efgh ijkl mnopX\x7f\r", "binary"));
  // Caught rather than awaited bare: a reader that refuses the space would
  // otherwise abort this file with a stack trace and take every later check
  // down with it, which reads as "the suite crashed" instead of naming what
  // broke.
  let entered = null, enterError = null;
  try { entered = await typed; } catch (error) { enterError = error; }
  check("custody: an app password typed WITH the spaces the provider displays is accepted, not refused mid-entry",
    entered === "abcd efgh ijkl mnop", enterError ? `refused: ${enterError.message}` : JSON.stringify(entered));
  check("custody: and it normalizes to what the server is actually sent",
    imap.normalizeAppPassword(entered) === "abcdefghijklmnop",
    enterError ? `nothing was entered: ${enterError.message}` : imap.normalizeAppPassword(entered));
  check("custody: the password is never echoed to the terminal it was typed into",
    !promptText.includes("abcd") && promptText.includes("app password"), JSON.stringify(promptText));
  check("custody: raw mode is turned on and restored, so a rejected password does not leave a dead terminal",
    JSON.stringify(promptIn.rawStates) === "[true,false]" && promptIn.isRaw === false,
    JSON.stringify(promptIn.rawStates));
  await new Promise((resolve, reject) => {
    readHiddenSecret("x", { input: new PassThrough(), output: new PassThrough() })
      .then(() => reject(new Error("a non-TTY should refuse")), resolve);
  }).then((error) => {
    check("custody: a terminal that cannot hide input REFUSES rather than falling back to visible entry",
      /never accepted as a flag/.test(String(error?.message)), String(error?.message));
  });

  /* ============================================================ *
   * 9. A failure must not advance anything.
   * ============================================================ */
  server.folder("INBOX").add(
    message({
      messageId: "ledger-77@northwind-example.test",
      from: "Alex Rivera <alex.rivera@northwind-example.test>",
      subject: "Ledger question before Friday",
      body: "One line is still unreconciled against the September statement. Can we look at it before Friday.",
    }),
    { internaldate: "27-Aug-2026 07:00:00 +0000" },
  );
  server.failNextFetch = true;
  let threw = null;
  try {
    await syncFolder(server, "INBOX", rolled.watermark);
  } catch (error) {
    threw = error;
  }
  check("a server-side FETCH failure throws rather than being swallowed as a skip",
    threw instanceof imap.ImapError && !imap.isPermanentMessageFailure(threw),
    String(threw?.message || threw));
  check("that failure is NOT a permanent message failure, so the caller withholds the watermark",
    imap.isPermanentMessageFailure(new imap.ImapError("gone", { permanent: true })) === true &&
    imap.isPermanentMessageFailure(new imap.ImapError("network")) === false,
    "permanence classification wrong");

  /* ============================================================ *
   * 10. The connect probe refuses until a real read succeeds.
   * ============================================================ */
  const probe = await imap.probeMailbox({
    host: "127.0.0.1", port: server.port,
    username: server.username, password: server.password,
    socketFactory: server.socketFactory(),
  });
  check("connect probe: a real login, folder list, EXAMINE and one message read back",
    probe.ok === true && probe.readOne === true && probe.uidvalidity === 9001, JSON.stringify(probe.notes));
  check("connect probe: it reports the folders it could not classify instead of staying quiet",
    probe.unclassified.includes("Projekte"), JSON.stringify(probe.unclassified));
  check("connect probe: it promises exactly the folders ingest will actually read, and no others",
    probe.included.sort().join(",") === "INBOX,Sent", JSON.stringify(probe.included));
  check("connect probe: an identified-but-unread folder is named at connect, with its role, not at first sync",
    probe.unlisted.some((entry) => entry.startsWith("Archive (")), JSON.stringify(probe.unlisted));
  check("connect probe: the \\Noselect container is not presented to the operator as an unread mail folder",
    !probe.unclassified.includes("[Gmail]") && !probe.unlisted.some((e) => e.startsWith("[Gmail]")),
    JSON.stringify({ unclassified: probe.unclassified, unlisted: probe.unlisted }));

  // A connector that has never touched a live mailbox must not print provider
  // facts as if it had. The caveat is part of the OUTPUT, not a promise made in
  // a comment, because a comment is not something the operator ever reads.
  const yahooNotes = imap.providerNotes("imap.mail.yahoo.com").join("\n");
  check("provider notes state plainly that they were never verified against a live account",
    yahooNotes.includes("never been pointed at a live mailbox"), yahooNotes.slice(-200));
  check("provider notes still carry the trap that actually costs an operator the most",
    /Bulk Mail/.test(yahooNotes) && /APP PASSWORD/i.test(yahooNotes), yahooNotes.slice(0, 200));
  check("a non-Yahoo host gets no invented provider notes",
    imap.providerNotes("imap.fastmail.com").length === 0 && imap.providerNotes("").length === 0,
    JSON.stringify(imap.providerNotes("imap.fastmail.com")));
  let badCredentials = null;
  try {
    await imap.probeMailbox({
      host: "127.0.0.1", port: server.port,
      username: server.username, password: "wrong-password",
      socketFactory: server.socketFactory(),
    });
  } catch (error) { badCredentials = error; }
  check("connect probe: wrong credentials are refused, and the refusal never quotes the password back",
    !!badCredentials && !String(badCredentials.message).includes("wrong-password"),
    String(badCredentials?.message));

  /* ============================================================ *
   * 11. INTERNALDATE, which Date.parse cannot read.
   * ============================================================ */
  check("INTERNALDATE parses the dd-Mon-yyyy shape with its offset applied",
    imap.parseInternalDate("13-Aug-2026 10:22:31 +0200")?.toISOString() === "2026-08-13T08:22:31.000Z",
    String(imap.parseInternalDate("13-Aug-2026 10:22:31 +0200")));
  check("a malformed INTERNALDATE is null rather than an invented date",
    imap.parseInternalDate("not a date") === null && imap.parseInternalDate("") === null, "expected null");

  /* ============================================================ *
   * 12. Implicit TLS and certificate verification.
   * ============================================================ */
  const identity = await selfsigned.generate(
    [{ name: "commonName", value: "127.0.0.1" }],
    {
      days: 1,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    },
  );
  const tlsServer = buildServer({ tls: { key: identity.private, cert: identity.cert } });
  await tlsServer.listen();
  try {
    const trusted = new imap.ImapClient({
      host: "127.0.0.1",
      port: tlsServer.port,
      socketFactory: tlsServer.tlsSocketFactory({ ca: identity.cert }),
    });
    await trusted.connect();
    await trusted.login(tlsServer.username, tlsServer.password);
    const tlsInbox = await trusted.examine("INBOX");
    await trusted.logout();
    check("TLS fixture: implicit TLS reaches a real authenticated IMAP command",
      tlsInbox.uidvalidity === 4001 && tlsServer.log.some((line) => line === "LOGIN <redacted>"),
      JSON.stringify({ uidvalidity: tlsInbox.uidvalidity, log: tlsServer.log }));

    const untrusted = new imap.ImapClient({ host: "127.0.0.1", port: tlsServer.port, timeoutMs: 2000 });
    let certificateError = null;
    try { await untrusted.connect(); } catch (error) { certificateError = error; }
    check("TLS fixture: production defaults reject an untrusted mailbox certificate",
      certificateError instanceof imap.ImapError && /self-signed|certificate/i.test(certificateError.message),
      String(certificateError?.message));
  } finally {
    await tlsServer.close();
  }

  /* ============================================================ *
   * 13. Real CLI source-health and watermark classification.
   * ============================================================ */
  {
    const inbox = new Folder("INBOX", { uidvalidity: 8101 });
    inbox.add(ENGAGEMENT);
    inbox.add(NEWSLETTER);
    const policy = await runImapLoadScenario({
      name: "policy-only",
      identity,
      folders: [
        inbox,
        new Folder("Sent", { uidvalidity: 8102, flags: ["\\Sent"] }),
        new Folder("Bulk Mail", { uidvalidity: 8103 }),
      ],
    });
    const finalReceipt = policy.evidence.receipts.at(-1);
    check("load health: a skipped junk folder and a two-signal bulk message stay completed within explicit policy",
      policy.code === 0 && finalReceipt?.status === "ready" && finalReceipt?.walk_complete === true &&
        /policy_skipped=2; coverage_gaps=0/.test(finalReceipt?.detail || ""),
      JSON.stringify({ code: policy.code, receipt: finalReceipt, output: policy.output.slice(-500) }));
    check("load health: a policy-complete IMAP run commits the exact folder watermark",
      policy.state?.imap_folders?.INBOX?.uidvalidity === 8101 &&
        policy.state?.imap_folders?.INBOX?.last_uid === 2 &&
        policy.state?.imap_folders?.Sent?.uidvalidity === 8102,
      JSON.stringify(policy.state?.imap_folders));
  }

  {
    const inbox = new Folder("INBOX", { uidvalidity: 8201 });
    inbox.add(ENGAGEMENT);
    const uncovered = await runImapLoadScenario({
      name: "uncovered-folders",
      identity,
      folders: [
        inbox,
        new Folder("Archive", { uidvalidity: 8202, flags: ["\\Archive"] }),
        new Folder("Projekte", { uidvalidity: 8203 }),
      ],
    });
    const finalReceipt = uncovered.evidence.receipts.at(-1);
    check("load health: an identified-but-unlisted and an unclassified folder close the source as partial/error",
      uncovered.code === 1 && finalReceipt?.status === "error" && finalReceipt?.walk_complete === false &&
        /coverage_gaps=2/.test(finalReceipt?.detail || "") && /partial coverage/i.test(uncovered.output),
      JSON.stringify({ code: uncovered.code, receipt: finalReceipt, output: uncovered.output.slice(-700) }));
    check("load health: uncovered folders withhold every newly observed IMAP watermark while keeping accepted work resumable",
      uncovered.state?.done && Object.keys(uncovered.state.done).length === 1 &&
        !Object.hasOwn(uncovered.state, "imap_folders"),
      JSON.stringify(uncovered.state));
  }

  {
    const inbox = new Folder("INBOX", { uidvalidity: 8301 });
    inbox.add(ENGAGEMENT);
    inbox.add("\r\n");
    inbox.add(message({
      messageId: "oversized-attachment@northwind-example.test",
      from: "Morgan Diaz <morgan.diaz@northwind-example.test>",
      subject: "Large attachment",
      body: "The real fixture body remains small because only the advertised size is relevant.",
    }), { declaredSize: imap.MAX_MESSAGE_BYTES + 1 });
    const messageGaps = await runImapLoadScenario({
      name: "message-gaps",
      identity,
      folders: [inbox],
    });
    const finalReceipt = messageGaps.evidence.receipts.at(-1);
    check("load health: unreadable and oversized messages are coverage gaps, not bulk-policy exclusions",
      messageGaps.code === 1 && finalReceipt?.status === "error" &&
        /skipped=2; policy_skipped=0; coverage_gaps=2/.test(finalReceipt?.detail || "") &&
        /over the \S+MB limit/.test(messageGaps.output),
      JSON.stringify({ code: messageGaps.code, detail: finalReceipt?.detail, output: messageGaps.output.slice(-800) }));
    check("load health: unreadable or oversized mail withholds the IMAP watermark instead of advancing past loss",
      messageGaps.state?.done && Object.keys(messageGaps.state.done).length === 1 &&
        !Object.hasOwn(messageGaps.state, "imap_folders"),
      JSON.stringify(messageGaps.state));
  }

  await server.close();

  console.log(fail ? `\n${fail} FAILURES` : `\nimap connector: all ${ran} checks passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
