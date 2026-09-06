/**
 * IMAP as an ingest source: the mailbox door for everyone who is not on Gmail.
 *
 * WHY THIS EXISTS. Email is a financial and contractual record for about half
 * the people this product is built for, and until now the only mailbox it could
 * read was Gmail's. A business owner on Yahoo, Fastmail, iCloud or a host their
 * accountant set up in 2011 had one option, which was nothing.
 *
 * THREE DESIGN CHOICES WORTH KNOWING, EACH INHERITED FROM `gmail.mjs` ON PURPOSE
 *
 * 1. Raw RFC 822, not a parsed API shape. `BODY.PEEK[]` returns the whole
 *    message and it is handed to the SAME `.eml` reader the Gmail connector,
 *    the mbox splitter and a file dropped in a folder all use. One mail parser
 *    in this product, not two that drift.
 *
 * 2. EXAMINE, never SELECT. EXAMINE is read-only at the protocol level and
 *    cannot set \Seen. Marking a client's unread mail as read while "just
 *    reading" it is the kind of visible harm that ends an install, and the
 *    difference is one keyword.
 *
 * 3. Bulk mail is excluded, and the MECHANISM IS DIFFERENT FROM GMAIL'S, which
 *    matters enough to say twice. Gmail filters server-side on its own category
 *    classifier. IMAP has no classifier and no equivalent query, so this filters
 *    locally on headers after the fetch. Same intent, weaker instrument, stated
 *    rather than glossed. See BULK_POLICY below for why a bare
 *    List-Unsubscribe check was rejected.
 *
 * NO NEW DEPENDENCY. The protocol client below is written directly on node:tls
 * because `ingest/extract.mjs` states the doctrine and its reason: everything on
 * the client's install path needs zero dependencies, because every package is
 * one more thing that can fail on their Windows box while somebody watches. The
 * read-only subset of IMAP this needs is small (CAPABILITY, LOGIN, LIST,
 * EXAMINE, UID SEARCH, UID FETCH, NOOP, LOGOUT) and the hard half of email,
 * MIME, was already paid for by postal-mime.
 *
 * NOTHING HERE IS OURS. The mailbox, the app password and the machine it is
 * stored on all belong to the client. The credential is written to their own
 * macOS Keychain or DPAPI store under an item named for IMAP, never inside the
 * item labelled Google, so they can find, audit and revoke exactly this one.
 */

import { createHash } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { homedir } from "node:os";
import { join } from "node:path";

import { extract } from "../ingest/extract.mjs";
// Side-effect import, and NOT optional. Without it the dependency-free
// fallback .eml reader in extract.mjs runs: it cannot decode RFC 2047 subjects
// or quoted-printable bodies, and it fails silently rather than erroring, which
// is a quality collapse nobody would see.
import "../ingest/formats.mjs";
import { parseEmailMessage } from "../ingest/formats.mjs";
import { textQuality } from "../ingest/quality.mjs";
import { loadTokens, saveTokens, tokenStorageDescription } from "./google-auth.mjs";

/** Both connectors write email, so both must land in one retrieval category. */
export const SOURCE_TYPE = "email";

/** Implicit TLS. STARTTLS on 143 is not offered: a downgrade is a silent one. */
export const DEFAULT_IMAP_PORT = 993;

/* ===================================================================== *
 * Credential custody
 * ===================================================================== */

/**
 * A DISTINCT, AUDITABLE ITEM, not a new store.
 *
 * `google-auth.mjs` says the Google service and account names are deliberately
 * explicit "so a person can find, audit, or delete this exact credential in
 * Keychain Access without guessing which generic-password entry belongs to the
 * brain". Putting a mailbox app password inside an item labelled "Google OAuth
 * credentials" would break exactly that promise, so IMAP gets its own item
 * name, its own file path and its own environment override, and reuses the
 * existing chunking, atomic generation swap, SHA-256 verification and DPAPI
 * code through the seams those functions already expose.
 *
 * One record per mailbox, keyed by source name, so a client with two mailboxes
 * can revoke one without touching the other.
 */
export const IMAP_KEYCHAIN_SERVICE = "brain-installer.imap";
export const IMAP_KEYCHAIN_COMMENT = "IMAP mailbox credentials for Brain Installer";
export const IMAP_CREDENTIAL_STORE_ENV = "BRAIN_IMAP_CREDENTIAL_STORE";
export const imapCredentialPath = (home = homedir()) => join(home, ".brain", "imap-credentials.json");

export function imapStorageOptions({ sourceName = "imap", home, ...rest } = {}) {
  return {
    keychainService: IMAP_KEYCHAIN_SERVICE,
    keychainAccount: `imap-${sourceName}`,
    keychainComment: IMAP_KEYCHAIN_COMMENT,
    // Its own name on purpose. BRAIN_GOOGLE_TOKEN_STORE must not decide where a
    // mailbox password lives, or the Drive scheduler's child-environment rules
    // would carry Google's semantics onto a connector they were never about.
    storeEnv: IMAP_CREDENTIAL_STORE_ENV,
    path: imapCredentialPath(home || homedir()),
    ...rest,
  };
}

/** The stored record for one mailbox, or null. Never logged, never echoed. */
export function loadImapCredentials(options = {}) {
  const store = loadTokens(imapStorageOptions(options));
  const record = store?.imap || null;
  if (!record?.host || !record?.username || !record?.password) return null;
  return record;
}

export function saveImapCredentials(record, options = {}) {
  const storage = imapStorageOptions(options);
  const store = loadTokens(storage);
  store.imap = { ...record, connected_at: new Date().toISOString() };
  saveTokens(store, storage);
  return store.imap;
}

export function removeImapCredentials(options = {}) {
  const storage = imapStorageOptions(options);
  const store = loadTokens(storage);
  if (!store?.imap) return false;
  delete store.imap;
  saveTokens(store, storage);
  return true;
}

export function imapCredentialStorageDescription(options = {}) {
  return tokenStorageDescription(imapStorageOptions(options));
}

/**
 * Yahoo prints an app password as four groups of four, and people paste what
 * they see. The spaces are display only; sending them produces an
 * indistinguishable "invalid credentials" the client cannot debug.
 */
export function normalizeAppPassword(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/* ===================================================================== *
 * Modified UTF-7 (RFC 3501 section 5.1.3)
 * ===================================================================== */

/**
 * Non-ASCII mailbox names travel in a modified base64. Hardcoding the ASCII
 * name instead is how a non-English mailbox gets "no such mailbox" from
 * EXAMINE on a folder the client can plainly see in their webmail.
 */
export function decodeMailboxName(encoded) {
  const input = String(encoded ?? "");
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "&") { out += input[i++]; continue; }
    const end = input.indexOf("-", i + 1);
    if (end === -1) { out += input.slice(i); break; }
    const chunk = input.slice(i + 1, end);
    if (chunk === "") { out += "&"; i = end + 1; continue; }
    const b64 = chunk.replace(/,/g, "/") + "===".slice((chunk.length + 3) % 4);
    const bytes = Buffer.from(b64, "base64");
    for (let b = 0; b + 1 < bytes.length; b += 2) out += String.fromCharCode(bytes.readUInt16BE(b));
    i = end + 1;
  }
  return out;
}

export function encodeMailboxName(name) {
  const input = String(name ?? "");
  let out = "";
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const buf = Buffer.alloc(run.length * 2);
    run.forEach((code, index) => buf.writeUInt16BE(code, index * 2));
    out += "&" + buf.toString("base64").replace(/=+$/, "").replace(/\//g, ",") + "-";
    run = [];
  };
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === 0x26) { flush(); out += "&-"; continue; }
    if (code >= 0x20 && code <= 0x7e) { flush(); out += ch; continue; }
    // Astral characters are two UTF-16 units and both belong in the run.
    if (code > 0xffff) {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      run.push(high, ((code - 0x10000) % 0x400) + 0xdc00);
      continue;
    }
    run.push(code);
  }
  flush();
  return out;
}

/* ===================================================================== *
 * Folder classification
 * ===================================================================== */

/**
 * SPECIAL-USE (RFC 6154) first, names second.
 *
 * The name table is not decoration: SPECIAL-USE is only present when the server
 * advertises it, and a Gmail-tuned table is actively dangerous elsewhere.
 * Yahoo's spam folder has historically been called "Bulk Mail", so a table that
 * knows only "Spam" and "Junk" ingests the single highest-volume source of bulk
 * mail in the account while believing it excluded it.
 *
 * A folder that matches neither is reported as UNCLASSIFIED and left unread,
 * rather than guessed at. A silently unread folder and a silently read spam
 * folder are both failures; only one of them is recoverable by the operator,
 * and it is the one that gets reported.
 */
export const SPECIAL_USE_ROLES = Object.freeze({
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "all",
  "\\flagged": "flagged",
  "\\important": "important",
});

export const FOLDER_NAME_ROLES = Object.freeze({
  inbox: ["inbox"],
  sent: [
    "sent", "sent items", "sent mail", "sent messages", "[gmail]/sent mail",
    "enviados", "elementos enviados", "gesendet", "gesendete elemente",
    "envoyés", "messages envoyés", "posta inviata", "verzonden",
  ],
  drafts: ["drafts", "draft", "[gmail]/drafts", "borradores", "entwürfe", "brouillons", "bozze", "concepten"],
  trash: ["trash", "deleted", "deleted items", "deleted messages", "[gmail]/trash", "papelera", "papierkorb", "corbeille", "cestino", "prullenbak"],
  // "Bulk Mail" and "Bulk" are Yahoo. Losing them loses the whole point.
  junk: ["junk", "junk email", "junk e-mail", "spam", "bulk", "bulk mail", "[gmail]/spam", "correo no deseado", "unerwünscht", "indésirables", "posta indesiderata", "ongewenst"],
  archive: ["archive", "archives", "[gmail]/all mail", "all mail", "archivo", "archiv"],
});

export function classifyFolder({ name, flags = [] } = {}) {
  const decoded = decodeMailboxName(name);
  const lower = decoded.toLowerCase();
  if (lower === "inbox") return { name: decoded, raw: name, role: "inbox", by: "name" };
  for (const flag of flags) {
    const role = SPECIAL_USE_ROLES[String(flag).toLowerCase()];
    if (role) return { name: decoded, raw: name, role, by: "special-use" };
  }
  for (const [role, names] of Object.entries(FOLDER_NAME_ROLES)) {
    if (names.includes(lower)) return { name: decoded, raw: name, role, by: "name" };
    // "[Gmail]/Sent Mail" style, and any server whose delimiter puts the role
    // in the last segment.
    const tail = lower.split(/[/.\\]/).pop();
    if (names.includes(tail)) return { name: decoded, raw: name, role, by: "name" };
  }
  return { name: decoded, raw: name, role: null, by: "unclassified" };
}

/* ===================================================================== *
 * The bulk-mail policy
 * ===================================================================== */

/**
 * WHY THIS IS NOT A LIST-UNSUBSCRIBE CHECK.
 *
 * `gmail.mjs` already considered and rejected that: "plenty of legitimate
 * business senders set that header too". A supplier's transactional thread and
 * a marketing blast both carry List-Unsubscribe, and dropping the supplier is a
 * worse failure than keeping one newsletter — the client asks why their
 * invoice thread is missing and there is no good answer.
 *
 * So bulk requires TWO independent signals. A newsletter reliably carries a
 * List-Id alongside its unsubscribe header, or a campaign header, or
 * Precedence: bulk. A human writing to you carries at most one of these by
 * accident.
 *
 * HOW THIS DIFFERS FROM GMAIL, PLAINLY: Gmail excludes bulk with a server-side
 * query against Google's own trained classifier, and never fetches the message.
 * IMAP has no such query and no classifier, so this fetches everything in the
 * included folders and decides locally. It is a weaker instrument on a larger
 * download. It will keep some newsletters Gmail would have dropped, and the
 * skip report names every message it did drop and why.
 */
export const BULK_POLICY = Object.freeze({
  version: 1,
  /** Two signals, not one. The whole discrimination lives in this number. */
  min_signals: 2,
  signals: Object.freeze(["list-id", "precedence", "auto-submitted", "list-unsubscribe", "campaign"]),
  /** Roles never read. Junk is the provider's OWN classifier and is free. */
  skip_roles: Object.freeze(["junk", "trash", "drafts", "all"]),
  /** Read by default. Sent is not optional: Gmail's query does not exclude it. */
  include_roles: Object.freeze(["inbox", "sent"]),
});

const CAMPAIGN_HEADERS = ["feedback-id", "x-campaign", "x-campaignid", "x-campaign-id", "x-mailgun-campaign-id", "x-ses-configuration-set", "x-sg-eid", "x-mailchimp-campaign-id"];
const CAMPAIGN_MAILERS = /(mailchimp|sendgrid|mailgun|constant ?contact|campaign ?monitor|klaviyo|hubspot|marketo|sendinblue|brevo|activecampaign|drip|convertkit)/i;

/** Which bulk signals a message carries. Returned as names so a skip can say. */
export function bulkSignals(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  const found = [];
  if (get("list-id")) found.push("list-id");
  const precedence = String(get("precedence") || "").trim().toLowerCase();
  if (["bulk", "list", "junk"].includes(precedence)) found.push("precedence");
  const auto = String(get("auto-submitted") || "").trim().toLowerCase();
  if (auto && auto !== "no") found.push("auto-submitted");
  if (get("list-unsubscribe")) found.push("list-unsubscribe");
  const mailer = String(get("x-mailer") || "");
  if (CAMPAIGN_HEADERS.some((h) => get(h)) || CAMPAIGN_MAILERS.test(mailer)) found.push("campaign");
  return found;
}

export function isBulkMail(headers, policy = BULK_POLICY) {
  return bulkSignals(headers).length >= policy.min_signals;
}

/**
 * A fingerprint of every decision that changes WHICH mail is kept.
 *
 * Drive already does this. Without it, tightening or loosening the filter
 * applies only to mail that arrives afterwards, and the old decisions sit in
 * the index invisibly disagreeing with the current policy. A changed
 * fingerprint forces a full pass, which the content-stable document id below
 * makes cheap.
 */
export function imapPolicyFingerprint(policy = BULK_POLICY, folders = []) {
  const shape = JSON.stringify({
    version: policy.version,
    min_signals: policy.min_signals,
    signals: [...policy.signals].sort(),
    skip_roles: [...policy.skip_roles].sort(),
    include_roles: [...policy.include_roles].sort(),
    folders: [...folders].sort(),
  });
  return createHash("sha256").update(shape).digest("hex");
}

/* ===================================================================== *
 * Header block parsing
 * ===================================================================== */

/**
 * The raw header block, unfolded, lowercased keys.
 *
 * Read from the octets we already hold rather than issued as a second
 * BODY.PEEK[HEADER.FIELDS] fetch: the whole message is downloaded regardless,
 * so a header-only fetch would double the round trips to re-read bytes already
 * in memory. Values are NOT RFC 2047 decoded here on purpose — every header
 * this reads (List-Id, Precedence, Message-ID) is defined as ASCII, and the two
 * headers that do carry names, Subject and From, come from postal-mime, which
 * decodes them properly.
 */
export function parseHeaderBlock(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw ?? "");
  const end = text.search(/\r?\n\r?\n/);
  const block = end === -1 ? text : text.slice(0, end);
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const map = new Map();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // First occurrence wins; a second Message-ID is a forgery signal, not an
    // update, and last-wins would let it take over.
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

/* ===================================================================== *
 * INTERNALDATE
 * ===================================================================== */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `"13-Aug-2026 10:22:31 +0000"`. Date.parse does not accept this shape. */
export function parseInternalDate(value) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2})(\d{2})\s*$/.exec(String(value ?? ""));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const date = new Date(utc - offset * 60_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

/* ===================================================================== *
 * The protocol client
 * ===================================================================== */

export class ImapError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "ImapError";
    this.permanent = permanent;
  }
}

/**
 * A UID that SEARCH listed and FETCH did not return.
 *
 * This is the ONLY message-level condition safe to swallow as a skip, and it is
 * the direct analogue of the Gmail connector's 404 rule: the message was
 * expunged between the two commands, so retrying can never produce it. Any
 * other failure belongs to the connector, not the message, and must escape so
 * the caller withholds the UID watermark rather than advancing past mail it
 * never read.
 */
export function isPermanentMessageFailure(error) {
  return error instanceof ImapError && error.permanent === true;
}

const CRLF = "\r\n";

export class ImapClient {
  constructor({
    host,
    port = DEFAULT_IMAP_PORT,
    socketFactory = null,
    timeoutMs = 60_000,
    onNotice = null,
  } = {}) {
    this.host = host;
    this.port = port;
    this.socketFactory = socketFactory;
    this.timeoutMs = timeoutMs;
    this.onNotice = onNotice;
    this.socket = null;
    this.capabilities = new Set();
    this.seq = 0;
    this.chain = Promise.resolve();
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.literalRemaining = 0;
    this.literalChunks = [];
    this.pending = null;
    this.greeting = null;
    this.closed = false;
  }

  /* -------------------------------------------------------------- wire */

  async connect() {
    const socket = this.socketFactory
      ? await this.socketFactory({ host: this.host, port: this.port })
      // Certificate verification is left at Node's default, which is on. An
      // IMAP client that disables it is a plaintext client wearing a costume.
      : tlsConnect({ host: this.host, port: this.port, servername: this.host });
    this.socket = socket;
    socket.setTimeout?.(this.timeoutMs);
    socket.on("data", (chunk) => this.#ingest(chunk));
    socket.on("error", (error) => this.#fail(new ImapError(`the mailbox connection failed: ${error.message}`)));
    socket.on("timeout", () => {
      socket.destroy();
      this.#fail(new ImapError(`the mailbox did not answer within ${Math.round(this.timeoutMs / 1000)}s`));
    });
    socket.on("close", () => {
      this.closed = true;
      this.#fail(new ImapError("the mailbox closed the connection"));
    });

    // The server speaks first: an IMAP session opens with an untagged greeting,
    // so there is nothing to send and nothing to wait for except that line.
    const greeting = await new Promise((resolve, reject) => {
      this.greeting = { resolve, reject };
    });
    this.greeting = null;
    const text = greeting.parts.map((p) => p.text ?? "").join(" ");
    if (/^\*\s+(BYE|NO|BAD)\b/i.test(text)) throw new ImapError(`the mailbox refused the connection: ${text.slice(0, 200)}`);
    this.#absorbCapabilities(text);
    return text;
  }

  #fail(error) {
    const waiter = this.pending || this.greeting;
    this.pending = null;
    this.greeting = null;
    if (waiter) waiter.reject(error);
  }

  #ingest(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.literalRemaining > 0) {
        if (!this.buffer.length) return;
        const take = Math.min(this.literalRemaining, this.buffer.length);
        this.literalChunks.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.literalRemaining -= take;
        if (this.literalRemaining > 0) return;
        this.parts.push({ literal: true, data: Buffer.concat(this.literalChunks) });
        this.literalChunks = [];
        continue;
      }
      const index = this.buffer.indexOf("\r\n");
      if (index === -1) return;
      const line = this.buffer.subarray(0, index).toString("latin1");
      this.buffer = this.buffer.subarray(index + 2);
      // `{N}` at the end of a server line means exactly N octets follow, then
      // the line resumes. Two-mode reading is the whole parser.
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (literal) {
        this.parts.push({ text: line.slice(0, literal.index) });
        this.literalRemaining = Number(literal[1]);
        this.literalChunks = [];
        if (this.literalRemaining === 0) this.parts.push({ literal: true, data: Buffer.alloc(0) });
        continue;
      }
      this.parts.push({ text: line });
      const response = this.parts;
      this.parts = [];
      this.#dispatch(response);
    }
  }

  #dispatch(parts) {
    const head = parts[0]?.text ?? "";
    if (this.greeting) { this.greeting.resolve({ parts }); this.greeting = null; return; }
    if (!this.pending) return;
    if (head.startsWith(`${this.pending.tag} `)) {
      const rest = head.slice(this.pending.tag.length + 1);
      const status = (rest.split(/\s+/, 1)[0] || "").toUpperCase();
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve({ status, text: rest, untagged: waiter.untagged });
      return;
    }
    this.#absorbCapabilities(head);
    this.pending.untagged.push(parts);
  }

  #absorbCapabilities(text) {
    const m = /\[?CAPABILITY\s+([^\]]+)\]?/i.exec(text || "");
    if (!m) return;
    for (const token of m[1].split(/\s+/)) if (token) this.capabilities.add(token.toUpperCase());
  }

  /**
   * One command at a time, always. Serialized because Yahoo throttles and drops
   * parallel connections, and because a dropped connection then costs one
   * command rather than an ambiguous half of several.
   */
  command(text, { secret = false } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (this.closed || !this.socket?.writable) {
        reject(new ImapError("the mailbox connection is closed"));
        return;
      }
      const tag = `B${++this.seq}`;
      this.pending = { tag, untagged: [], resolve, reject };
      this.socket.write(`${tag} ${text}${CRLF}`);
    }).then((result) => {
      if (result.status === "OK") return result;
      // A failing LOGIN must never quote the command back: the command IS the
      // password.
      // Name the command as the operator typed it conceptually: "UID FETCH",
      // not "UID". Never echo arguments; on LOGIN the argument IS the password.
      const words = text.split(" ");
      const named = words[0].toUpperCase() === "UID" ? `${words[0]} ${words[1] || ""}`.trim() : words[0];
      const label = secret ? "the mailbox rejected the credentials" : `the mailbox refused "${named}"`;
      throw new ImapError(`${label}: ${String(result.text || "").slice(0, 200)}`);
    });
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /* ---------------------------------------------------------- commands */

  async capability() {
    const result = await this.command("CAPABILITY");
    for (const parts of result.untagged) this.#absorbCapabilities(parts[0]?.text ?? "");
    return this.capabilities;
  }

  async login(username, password) {
    await this.command(`LOGIN ${quoted(username)} ${quoted(password)}`, { secret: true });
    // The post-LOGIN capability list is the authoritative one; the pre-auth
    // banner often advertises less.
    await this.capability();
    return true;
  }

  async list() {
    const result = await this.command('LIST "" "*"');
    const folders = [];
    for (const parts of result.untagged) {
      const { text, literals } = flatten(parts);
      if (!/^\*\s+LIST\b/i.test(text)) continue;
      const tokens = tokenize(text, literals);
      // * LIST (flags...) "delimiter" "name"
      const open = tokens.findIndex((t) => t.t === "punct" && t.v === "(");
      const close = tokens.findIndex((t, i) => i > open && t.t === "punct" && t.v === ")");
      if (open === -1 || close === -1) continue;
      const flags = tokens.slice(open + 1, close).map((t) => String(t.v));
      const rest = tokens.slice(close + 1).filter((t) => t.t !== "punct");
      const delimiter = valueOf(rest[0]);
      const name = valueOf(rest[1]);
      if (name == null) continue;
      folders.push({ ...classifyFolder({ name, flags }), flags, delimiter: delimiter === "NIL" ? null : delimiter });
    }
    return folders;
  }

  /** READ-ONLY. SELECT would set \Seen on the client's unread mail. */
  async examine(folderName) {
    const result = await this.command(`EXAMINE ${quoted(encodeMailboxName(folderName))}`);
    const lines = result.untagged.map((parts) => parts.map((p) => p.text ?? "").join(" ")).concat(result.text);
    const pick = (re) => {
      for (const line of lines) {
        const m = re.exec(line);
        if (m) return Number(m[1]);
      }
      return null;
    };
    const uidvalidity = pick(/\[UIDVALIDITY\s+(\d+)\]/i);
    if (uidvalidity == null) {
      // Without it there is no way to know whether the saved UIDs still mean
      // anything, and guessing "unchanged" is the silent-skip failure itself.
      throw new ImapError(`the mailbox did not report UIDVALIDITY for "${folderName}", so its saved position cannot be trusted`);
    }
    return { folder: folderName, uidvalidity, uidnext: pick(/\[UIDNEXT\s+(\d+)\]/i), exists: pick(/^\*\s+(\d+)\s+EXISTS/i) ?? 0 };
  }

  async uidSearch(criteria) {
    const result = await this.command(`UID SEARCH ${criteria}`);
    const uids = [];
    for (const parts of result.untagged) {
      const text = parts.map((p) => p.text ?? "").join(" ");
      const m = /^\*\s+SEARCH\b(.*)$/i.exec(text);
      if (!m) continue;
      for (const token of m[1].trim().split(/\s+/)) {
        const uid = Number(token);
        if (Number.isInteger(uid) && uid > 0) uids.push(uid);
      }
    }
    return uids.sort((a, b) => a - b);
  }

  async uidFetch(uids, items) {
    if (!uids.length) return [];
    const result = await this.command(`UID FETCH ${uids.join(",")} (${items})`);
    const messages = [];
    for (const parts of result.untagged) {
      const { text, literals } = flatten(parts);
      if (!/^\*\s+\d+\s+FETCH\b/i.test(text)) continue;
      const parsed = parseFetchItems(tokenize(text, literals));
      if (parsed?.uid) messages.push(parsed);
    }
    return messages;
  }

  async noop() { return this.command("NOOP"); }

  async logout() {
    if (this.closed || !this.socket?.writable) return;
    try { await this.command("LOGOUT"); } catch { /* closing is the point */ }
    try { this.socket.end(); } catch { /* already gone */ }
    this.closed = true;
  }
}

/* --------------------------------------------------------------- parsing */

const quoted = (value) => `"${String(value).replace(/([\\"])/g, "\\$1")}"`;

/**
 * Flatten a response into one text stream with literals replaced by markers.
 *
 * Literals are binary and cannot be tokenized as text, and a tokenizer that
 * walks parts and text simultaneously is the fiddly version of this. The marker
 * is NUL-delimited, which the protocol's own ASCII text never contains.
 */
/**
 * The literal marker.
 *
 * NUL cannot appear in IMAP protocol text (it is 7-bit ASCII with a defined
 * grammar), so it is the one delimiter that can never collide with a real
 * response. Written as an escape so the source file stays plain ASCII.
 */
const LITERAL_MARK = "\u0000";

function flatten(parts) {
  const literals = [];
  let text = "";
  for (const part of parts) {
    if (part.literal) {
      text += `${LITERAL_MARK}${literals.length}${LITERAL_MARK}`;
      literals.push(part.data);
      continue;
    }
    text += part.text ?? "";
  }
  return { text, literals };
}

const DELIMITERS = ` \t()[]${LITERAL_MARK}`;

function tokenize(text, literals = []) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === LITERAL_MARK) {
      const end = text.indexOf(LITERAL_MARK, i + 1);
      if (end === -1) break;
      tokens.push({ t: "literal", v: literals[Number(text.slice(i + 1, end))] ?? Buffer.alloc(0) });
      i = end + 1;
      continue;
    }
    if ("()[]".includes(ch)) { tokens.push({ t: "punct", v: ch }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      while (j < text.length) {
        if (text[j] === "\\") { out += text[j + 1] ?? ""; j += 2; continue; }
        if (text[j] === '"') break;
        out += text[j]; j++;
      }
      tokens.push({ t: "string", v: out });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !DELIMITERS.includes(text[j])) j++;
    tokens.push({ t: "atom", v: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

const valueOf = (token) => (token ? (token.t === "literal" ? token.v.toString("latin1") : String(token.v)) : null);

/** `* n FETCH (UID 1 INTERNALDATE "..." RFC822.SIZE 12 BODY[] {n}...)`. */
function parseFetchItems(tokens) {
  let i = tokens.findIndex((t) => t.t === "punct" && t.v === "(");
  if (i === -1) return null;
  i++;
  const out = {};
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.t === "punct" && token.v === ")") break;
    if (token.t !== "atom") { i++; continue; }
    let name = token.v.toUpperCase();
    i++;
    if (tokens[i]?.t === "punct" && tokens[i].v === "[") {
      let depth = 0;
      let section = "";
      for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.t === "punct" && t.v === "[") { depth++; if (depth === 1) continue; }
        if (t.t === "punct" && t.v === "]") { depth--; if (depth === 0) { i++; break; } }
        section += (t.t === "punct" ? t.v : String(t.v)) + " ";
      }
      name += `[${section.trim().split(/\s+/)[0] || ""}]`;
    }
    // Read one value.
    const value = tokens[i];
    if (value?.t === "punct" && value.v === "(") {
      let depth = 0;
      const list = [];
      for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.t === "punct" && t.v === "(") { depth++; continue; }
        if (t.t === "punct" && t.v === ")") { depth--; if (depth === 0) { i++; break; } continue; }
        list.push(valueOf(t));
      }
      out[name] = list;
      continue;
    }
    if (value?.t === "literal") { out[name] = value.v; i++; continue; }
    out[name] = value ? String(value.v) : null;
    i++;
  }
  const uid = Number(out.UID);
  return {
    uid: Number.isInteger(uid) && uid > 0 ? uid : null,
    internaldate: out.INTERNALDATE || null,
    size: Number(out["RFC822.SIZE"]) || null,
    raw: Buffer.isBuffer(out["BODY[]"]) ? out["BODY[]"] : null,
  };
}

/* ===================================================================== *
 * Incremental sync
 * ===================================================================== */

/**
 * THE UIDVALIDITY ANSWER, in one pure function so it can be tested without a
 * server and read without one.
 *
 * UIDVALIDITY is the server saying "the UIDs I gave you before mean nothing
 * now". It changes on mailbox recreation, some migrations and some provider
 * maintenance. Three things follow, and all three are load-bearing:
 *
 * 1. THE FOLDER IS RE-SEARCHED FROM UID 1, not from `last_uid + 1`. Continuing
 *    from the old watermark is the silent skip: under new numbering `last_uid`
 *    is an arbitrary point in an unrelated sequence, and every message below it
 *    would never be looked at again while the run reported success.
 *
 * 2. THE OPERATOR IS TOLD, in the same voice as the Gmail history-expiry
 *    warning. A resync that happens silently is indistinguishable from a bug.
 *
 * 3. THE NEW UIDVALIDITY IS NEVER RECORDED WITHOUT THE MAIL IT COVERS. The
 *    caller writes `{uidvalidity, last_uid}` as one object, after every batch
 *    has been accepted. If the resync dies halfway, state still holds the OLD
 *    pair, the next run sees the mismatch again and resyncs again. There is no
 *    reachable state where the new UIDVALIDITY is stored but its mail was not
 *    read, which is the only property that makes this safe.
 *
 * The re-read is cheap rather than free because the document id is
 * content-stable (see toEnvelope): every message resolves to `unchanged`, one
 * read each, no re-embedding.
 */
export function folderSyncDecision({
  storedUidvalidity = null,
  currentUidvalidity,
  lastUid = 0,
  reset = false,
  policyChanged = false,
  scannerPolicyChanged = false,
} = {}) {
  if (reset) {
    return { mode: "full", searchCriteria: "ALL", floor: 0, resynced: false, reason: "a reset was requested, so this folder is read in full" };
  }
  if (storedUidvalidity == null) {
    return { mode: "full", searchCriteria: "ALL", floor: 0, resynced: false, reason: "this folder has not been read before" };
  }
  if (Number(storedUidvalidity) !== Number(currentUidvalidity)) {
    return {
      mode: "full",
      searchCriteria: "ALL",
      floor: 0,
      resynced: true,
      reason:
        `the server changed UIDVALIDITY from ${storedUidvalidity} to ${currentUidvalidity}, which means every saved ` +
        "message number in this folder is meaningless, so the whole folder is read again rather than resumed",
    };
  }
  if (scannerPolicyChanged) {
    return {
      mode: "full",
      searchCriteria: "ALL",
      floor: 0,
      resynced: false,
      reason: "the credential scanner changed, so this folder is read again before the new scanner version is recorded",
    };
  }
  if (policyChanged) {
    return { mode: "full", searchCriteria: "ALL", floor: 0, resynced: false, reason: "the bulk-mail policy changed, so this folder is read again under the new rule" };
  }
  const floor = Number(lastUid) || 0;
  return {
    mode: "incremental",
    // RFC 3501 6.4.8: `n:*` ALWAYS returns at least the highest existing UID,
    // even when n is past it. Without the client-side floor below, this
    // re-fetches the newest message on every run, forever.
    searchCriteria: `UID ${floor + 1}:*`,
    floor,
    resynced: false,
    reason: null,
  };
}

/**
 * A mailbox name that cannot be opened at all.
 *
 * `\\Noselect` is a container: Gmail-over-IMAP's `[Gmail]` is one, and so is any
 * parent a server exposes purely to hold children. EXAMINE on one fails. It is
 * separated here because the alternative is telling an operator that a folder
 * "could not be identified and was not read", about a thing that is not a mail
 * folder and never held a message.
 */
export const NON_SELECTABLE_FLAGS = Object.freeze(["\\noselect", "\\nonexistent"]);

export function isSelectable(folder) {
  const flags = (folder?.flags || []).map((flag) => String(flag).toLowerCase());
  return !NON_SELECTABLE_FLAGS.some((flag) => flags.includes(flag));
}

/**
 * Every folder sorted into what will actually happen to it, and WHY.
 *
 * Five buckets rather than three, because three forced two different situations
 * to share one sentence and the sentence was false for one of them. An Archive
 * folder IS identified; saying it "could not be classified" is a lie of exactly
 * the kind this product is built not to tell, and it is the more alarming of
 * the two readings for the operator. So:
 *
 *   included     read.
 *   skipped      a role this policy deliberately never reads (junk, trash...).
 *   unlisted     a role that WAS identified, that no rule includes. Archive is
 *                the real case, and it can hold years of a client's mail.
 *   unclassified a selectable folder whose role genuinely could not be worked
 *                out. Only these are reported as unidentified.
 *   containers   not mail folders at all; reported as such, or not at all.
 *
 * All five are returned because all five are REPORTED: a folder that was
 * silently never opened produces a brain that is confidently ignorant of it.
 */
export function partitionFolders(folders, policy = BULK_POLICY) {
  const included = [];
  const skipped = [];
  const unlisted = [];
  const unclassified = [];
  const containers = [];
  for (const folder of folders || []) {
    if (!isSelectable(folder)) { containers.push(folder); continue; }
    if (policy.include_roles.includes(folder.role)) included.push(folder);
    else if (policy.skip_roles.includes(folder.role)) skipped.push(folder);
    else if (folder.role) unlisted.push(folder);
    else unclassified.push(folder);
  }
  return { included, skipped, unlisted, unclassified, containers };
}

/**
 * The mid-run UIDVALIDITY guard.
 *
 * A server can roll UIDVALIDITY DURING a long folder: maintenance, a migration,
 * or a reconnect after an idle timeout landing on a different backend. The
 * watermark just measured is a number in the OLD sequence, and writing it
 * against the NEW UIDVALIDITY would tell the next run "everything up to here is
 * read" about a numbering that never existed. So this refuses: the run fails,
 * the cursor is withheld, and the folder is read again in full next time.
 */
export function assertUidvalidityStable(folder, before, after) {
  if (Number(before) === Number(after)) return true;
  throw new ImapError(
    `${folder}: the server changed UIDVALIDITY from ${before} to ${after} DURING this run, so the messages just read are ` +
      "numbered under a scheme that no longer exists. Nothing was recorded for this folder and the next run reads it in full."
  );
}

/**
 * Per-folder positions are a MERGE, never a scalar assign.
 *
 * The shared cursor machinery writes `state[key] = value` once, so the value
 * has to be the whole map. A connector that handed back only the folders it
 * touched this run would erase the position of every folder it did not, and
 * the next run would silently re-read them from zero.
 *
 * Each entry is `{uidvalidity, last_uid}` written as ONE object: a new
 * UIDVALIDITY never lands without the watermark it belongs to.
 */
export function mergeFolderWatermarks(saved, observed) {
  return { ...(saved || {}), ...(observed || {}) };
}

/** Apply the floor RFC 3501 6.4.8 makes necessary. */
export const aboveFloor = (uids, floor) => uids.filter((uid) => uid > Number(floor || 0));

/** Bigger batches mean less latency; a whole mailbox in one FETCH means OOM. */
export const FETCH_BATCH = 40;
/** One message this large is an attachment dump, not correspondence. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * One folder's new messages, streamed.
 *
 * An async generator so `batchStream` consumes it exactly as it consumes Drive
 * pages and Gmail ids: an interrupt costs one batch, not the run.
 *
 * The mid-run UIDVALIDITY re-check is not paranoia. Yahoo drops idle
 * connections, a reconnect means a second EXAMINE, and a second EXAMINE can
 * report a different UIDVALIDITY. Continuing to fetch UIDs from the old
 * numbering after that would read the wrong messages under the right ids.
 */
export async function* streamFolder(client, folder, { criteria, floor = 0, batchSize = FETCH_BATCH, uidvalidity } = {}) {
  const uids = aboveFloor(await client.uidSearch(criteria), floor);
  for (let start = 0; start < uids.length; start += batchSize) {
    const slice = uids.slice(start, start + batchSize);
    // Sizes first, bodies second. A 90MB message is refused without ever being
    // pulled into memory, which one combined fetch cannot do.
    const sized = await client.uidFetch(slice, "UID INTERNALDATE RFC822.SIZE");
    const byUid = new Map(sized.map((m) => [m.uid, m]));
    const wanted = [];
    for (const uid of slice) {
      const meta = byUid.get(uid);
      if (!meta) {
        // Listed by SEARCH, gone by FETCH: expunged in between. The one
        // message-level condition that may be forgotten.
        yield { folder, uid, uidvalidity, missing: true };
        continue;
      }
      if (meta.size && meta.size > MAX_MESSAGE_BYTES) {
        yield { folder, uid, uidvalidity, oversized: meta.size, internaldate: meta.internaldate };
        continue;
      }
      wanted.push(uid);
    }
    if (!wanted.length) continue;
    const bodies = await client.uidFetch(wanted, "UID INTERNALDATE RFC822.SIZE BODY.PEEK[]");
    const bodyByUid = new Map(bodies.map((m) => [m.uid, m]));
    for (const uid of wanted) {
      const message = bodyByUid.get(uid);
      if (!message?.raw) { yield { folder, uid, uidvalidity, missing: true }; continue; }
      yield {
        folder,
        uid,
        uidvalidity,
        raw: message.raw,
        size: message.size ?? message.raw.length,
        internaldate: message.internaldate || byUid.get(uid)?.internaldate || null,
      };
    }
  }
}

/* ===================================================================== *
 * Envelope construction
 * ===================================================================== */

/**
 * A document identity that survives what UIDs do not.
 *
 * Keying on `<folder>:<uid>` looks obvious and is the trap: one UIDVALIDITY
 * roll re-lands every message under a new id, the old family is never removed,
 * and the client's brain silently holds their mailbox twice. So the identity is
 * the message's own: its Message-ID, normalized, and a content hash when it has
 * none. That also collapses the same message seen in two folders into one
 * document, which is correct, and makes a resync resolve to `unchanged`.
 *
 * A Message-ID is not guaranteed unique — sent mail and a Bcc self-copy can
 * share one. Two messages sharing an id resolve to one document, which loses a
 * copy rather than corrupting one. That is the safe direction and it is stated
 * rather than hidden.
 */
export function messageIdentity({ messageId, headers, occurredAt, from, subject, text }) {
  const raw = String(messageId || headers?.get?.("message-id") || "").trim().replace(/^<|>$/g, "");
  if (raw) {
    const at = raw.lastIndexOf("@");
    const normalized = at === -1 ? raw : `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`;
    return { id: `mid:${normalized.slice(0, 400)}`, by: "message-id" };
  }
  const digest = createHash("sha256")
    .update(String(occurredAt || ""), "utf-8").update("\n")
    .update(String(from || ""), "utf-8").update("\n")
    .update(String(subject || ""), "utf-8").update("\n")
    .update(String(text || "").slice(0, 512), "utf-8")
    .digest("hex");
  return { id: `sha256:${digest}`, by: "content-hash" };
}

/**
 * One fetched message to one envelope, or to a reasoned skip.
 *
 * The subject comes from postal-mime's parsed header, NOT from a regex over the
 * rendered text. The Gmail connector recovers it with `/^Subject:\s*(.+)$/m`,
 * which on a subject-less message can match a `Subject:` line inside a quoted
 * or forwarded body and title the document with somebody else's subject. That
 * bug is not ported here.
 */
export async function toEnvelope(message, { sourceName = SOURCE_TYPE, host = "", policy = BULK_POLICY } = {}) {
  const where = `${message.folder}#${message.uid}`;
  if (message.missing) {
    return {
      skip: { path: where, id: where, reason: "the message was deleted from the mailbox between being listed and being read" },
      source_deleted: true,
      retain_existing: false,
    };
  }
  if (message.oversized) {
    return {
      skip: { path: where, id: where, reason: `the message is ${Math.round(message.oversized / 1024 / 1024)}MB, over the ${Math.round(MAX_MESSAGE_BYTES / 1024 / 1024)}MB limit for one message` },
      retain_existing: true,
    };
  }
  if (!message.raw?.length) {
    return {
      skip: { path: where, id: where, reason: "the message had no content" },
      retain_existing: true,
    };
  }

  const headers = parseHeaderBlock(message.raw);
  const headerIdentity = headers.get("message-id")
    ? messageIdentity({ headers })
    : null;
  const signals = bulkSignals(headers);
  if (signals.length >= policy.min_signals) {
    return {
      skip: {
        path: where,
        id: where,
        // Named, not silent, and naming the signals so the operator can judge
        // a wrong call rather than guess at one.
        reason: `bulk mail: ${signals.join(" + ")} (${signals.length} of the ${policy.min_signals} signals this filter requires)`,
      },
      ...(headerIdentity ? { source_id: headerIdentity.id } : {}),
      policy_skip: true,
      retain_existing: false,
    };
  }

  const got = await extract(message.raw, "message.eml");
  if (got.error || got.text == null) {
    return {
      skip: { path: where, id: where, reason: got.error || "the message could not be parsed" },
      ...(headerIdentity ? { source_id: headerIdentity.id } : {}),
      retain_existing: true,
    };
  }

  let parsed = {};
  try { parsed = await parseEmailMessage(message.raw); } catch { /* the rendered text above is still good */ }

  // INTERNALDATE is the RECEIPT time this server recorded, and it is the honest
  // document date. The Date: header is written by the sender's client and is
  // trivially wrong or forged, so a message with only that is marked unreliable
  // rather than quietly treated as equal.
  const internal = parseInternalDate(message.internaldate);
  const headerDate = parsed.occurredAt ? new Date(parsed.occurredAt) : null;
  const occurredAt = internal || (headerDate && Number.isFinite(headerDate.getTime()) ? headerDate : null);

  const identity = messageIdentity({
    messageId: parsed.messageId,
    headers,
    occurredAt: occurredAt?.toISOString() || null,
    from: parsed.from,
    subject: parsed.subject,
    text: got.text,
  });

  const q = textQuality(got.text);
  if (!q.ok) {
    return {
      skip: { path: where, id: where, reason: q.reason, metrics: q.metrics },
      source_id: identity.id,
      retain_existing: true,
    };
  }

  return {
    envelope: {
      source_type: sourceName,
      // Bare connector identity: the store adds the source type exactly once,
      // and pre-prefixing here made family deletion target a document that was
      // never stored.
      source_id: identity.id,
      title: String(parsed.subject || "(no subject)").slice(0, 200),
      content: got.text,
      occurred_at: occurredAt ? occurredAt.toISOString() : null,
      // Its OWN value, not "gmail_internal". Both are a server's receipt time
      // and conflating the labels destroys the provenance distinction.
      date_source: internal ? "imap_internaldate" : (occurredAt ? "message_date_header" : "none"),
      date_reliable: !!internal,
      // RFC 5092. Not clickable, and deliberately so: Yahoo has no stable
      // per-message web URL and inventing one that 404s is worse than none.
      uri: `imap://${host}/${encodeURIComponent(encodeMailboxName(message.folder))};UID=${message.uid}`,
      metadata: {
        category: sourceName,
        extracted_as: "imap",
        folder: message.folder,
        uid: message.uid,
        uidvalidity: message.uidvalidity,
        identity: identity.by,
        ...(parsed.from ? { sender: parsed.from } : {}),
      },
    },
    // CONTENT-derived, not `uidvalidity:uid:size`. A UID-derived version would
    // change for every message on a UIDVALIDITY roll and force a full re-embed,
    // defeating the whole point of the content-stable id above. This makes the
    // resync resolve to `unchanged`.
    version: `sha256:${createHash("sha256").update(message.raw).digest("hex").slice(0, 32)}`,
  };
}

/* ===================================================================== *
 * Connect-time probe
 * ===================================================================== */

/**
 * Refuse to connect until a real read succeeds.
 *
 * A connector that installs cleanly and fails on the first sync is worse than
 * one that refuses at connect time, because the failure arrives when nobody is
 * watching and the client believes their mail is in there. So this logs in,
 * lists folders, EXAMINEs the inbox and reads one message before anything is
 * written to the credential store.
 */
export async function probeMailbox({ host, port = DEFAULT_IMAP_PORT, username, password, socketFactory = null, timeoutMs = 30_000 } = {}) {
  const client = new ImapClient({ host, port, socketFactory, timeoutMs });
  const notes = [];
  try {
    await client.connect();
    await client.login(username, password);
    const folders = await client.list();
    const inbox = folders.find((f) => f.role === "inbox") || { name: "INBOX" };
    const status = await client.examine(inbox.name);
    const uids = await client.uidSearch("ALL");
    let readOne = false;
    if (uids.length) {
      const newest = uids.slice(-1);
      const fetched = await client.uidFetch(newest, "UID INTERNALDATE RFC822.SIZE BODY.PEEK[]");
      readOne = !!fetched[0]?.raw?.length;
      if (!readOne) notes.push("the newest message in the inbox could not be read, so this connection is not proven");
    } else {
      notes.push("the inbox is empty, so no message could be read; the login and folder list did succeed");
    }
    if (!client.capabilities.has("SPECIAL-USE")) {
      notes.push("this server does not advertise SPECIAL-USE, so folder roles were matched by NAME, which is localized and provider-specific");
    }
    // The SAME partition the sync loop uses, so connect cannot promise a folder
    // will be read that ingest then leaves alone.
    const partition = partitionFolders(folders);
    const unclassified = partition.unclassified.map((f) => f.name);
    const unlisted = partition.unlisted.map((f) => `${f.name} (${f.role})`);
    return {
      ok: readOne || uids.length === 0,
      folders,
      included: partition.included.map((f) => f.name),
      unclassified,
      unlisted,
      inbox: inbox.name,
      uidvalidity: status.uidvalidity,
      messages: uids.length,
      readOne,
      capabilities: [...client.capabilities].sort(),
      notes,
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Provider notes an operator would otherwise discover the hard way.
 *
 * Printed at connect, WITH its own caveat in the list rather than only in this
 * comment. Everything below is read from the provider's published behavior and
 * from the specification. This repository has never connected to a live Yahoo
 * account, so none of it is observed, and a note that reads as established fact
 * when it is not is the failure this product is built to avoid. The caveat is
 * therefore part of what gets printed, not a promise made in a comment that the
 * code does not keep.
 */
export const PROVIDER_NOTES_CAVEAT =
  "  These notes come from the provider's published behavior, not from a run against a real\n" +
  "  account: this connector has never been pointed at a live mailbox. If one of them turns out\n" +
  "  to be wrong, the note is wrong, not you.";

export function providerNotes(host = "") {
  const h = String(host).toLowerCase();
  if (/yahoo|ymail|rocketmail/.test(h)) {
    return [
      "Yahoo notes, worth reading before you blame this tool:",
      "  - An APP PASSWORD is required. Your normal Yahoo password is refused for IMAP,",
      "    and generating one requires two-step verification to be on first.",
      "    Generate it here: https://login.yahoo.com/account/security",
      "  - Yahoo shows that password as four groups of four. The spaces are display only.",
      "    They are stripped here, so pasting it either way works.",
      "  - Yahoo's spam folder is called \"Bulk Mail\", not Junk or Spam. It is skipped,",
      "    along with Trash and Drafts.",
      "  - Yahoo throttles and drops idle connections. This reads one folder at a time on",
      "    one connection, which is slower and survives.",
      "",
      PROVIDER_NOTES_CAVEAT,
    ];
  }
  return [];
}
