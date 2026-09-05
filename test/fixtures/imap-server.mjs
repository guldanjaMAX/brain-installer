// test/fixtures/imap-server.mjs
//
// A SCRIPTED IMAP SERVER, not a mock of the connector's own calls.
//
// It listens on a real TCP socket on 127.0.0.1, speaks the RFC 3501 wire
// format the connector actually parses (tagged commands, untagged responses,
// `{N}` literals with exactly N octets following), and holds mailbox state the
// test can mutate between runs. That is what makes a second-sync or a
// UIDVALIDITY-roll assertion mean something: the connector has to reissue real
// commands and re-read real bytes to get the right answer.
//
// WHAT IT IS NOT. It is plain TCP, not TLS. The production client calls
// `tls.connect` with certificate verification left at Node's default, and this
// fixture is reached through the connector's `socketFactory` seam instead.
// TLS negotiation and certificate verification are therefore NOT covered here.
// Every persona and address below is invented.

import { createServer } from "node:net";

const CRLF = "\r\n";

/**
 * One mailbox folder.
 *
 * `uidvalidity` is mutable on purpose: rolling it is exactly the event the
 * connector has to survive, and a fixture that could not roll it would leave
 * that whole path untested.
 */
export class Folder {
  constructor(name, { uidvalidity = 1000, flags = [] } = {}) {
    this.name = name;
    this.uidvalidity = uidvalidity;
    this.flags = flags;
    this.messages = new Map();
    this.nextUid = 1;
  }

  add(raw, { internaldate = "13-Aug-2026 10:22:31 +0000", uid = null } = {}) {
    const assigned = uid ?? this.nextUid++;
    if (assigned >= this.nextUid) this.nextUid = assigned + 1;
    this.messages.set(assigned, { uid: assigned, raw: Buffer.from(raw, "utf-8"), internaldate });
    return assigned;
  }

  /** Renumber everything from 1 and change UIDVALIDITY: a server-side reset. */
  rollUidvalidity(next) {
    this.uidvalidity = next;
    const ordered = [...this.messages.values()].sort((a, b) => a.uid - b.uid);
    this.messages = new Map();
    this.nextUid = 1;
    for (const message of ordered) this.add(message.raw.toString("utf-8"), { internaldate: message.internaldate });
  }

  uids() {
    return [...this.messages.keys()].sort((a, b) => a - b);
  }
}

export class ScriptedImapServer {
  constructor({ username, password, folders = [], capabilities = ["IMAP4rev1", "SPECIAL-USE"] } = {}) {
    this.username = username;
    this.password = password;
    this.folders = new Map(folders.map((f) => [f.name, f]));
    this.capabilities = capabilities;
    /** Every command line the client sent, minus the password. The tests assert on this. */
    this.log = [];
    /** Set true to prove a failing send does not advance a cursor. */
    this.failNextFetch = false;
    /** Omit one requested UID once, simulating SEARCH/FETCH race or incomplete FETCH. */
    this.omitNextFetchUid = null;
    this.server = null;
    this.port = 0;
  }

  folder(name) { return this.folders.get(name); }

  async listen() {
    this.server = createServer((socket) => this.#session(socket));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  /** The seam the connector accepts in place of `tls.connect`. */
  socketFactory() {
    const port = this.port;
    return async () => {
      const { connect } = await import("node:net");
      const socket = connect({ host: "127.0.0.1", port });
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    };
  }

  #session(socket) {
    let authenticated = false;
    let selected = null;
    let buffer = "";
    socket.write(`* OK [CAPABILITY ${this.capabilities.join(" ")}] scripted IMAP ready${CRLF}`);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      for (;;) {
        const index = buffer.indexOf(CRLF);
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [tag, ...rest] = line.split(" ");
        const command = (rest[0] || "").toUpperCase();
        const args = rest.slice(1);
        // The password is the argument to LOGIN. It never enters the log.
        this.log.push(command === "LOGIN" ? `${command} <redacted>` : rest.join(" "));
        const done = (status, text) => socket.write(`${tag} ${status} ${text}${CRLF}`);

        if (command === "CAPABILITY") {
          socket.write(`* CAPABILITY ${this.capabilities.join(" ")}${CRLF}`);
          done("OK", "CAPABILITY completed");
          continue;
        }
        if (command === "LOGIN") {
          const user = unquote(args[0]);
          const pass = unquote(args.slice(1).join(" "));
          if (user !== this.username || pass !== this.password) { done("NO", "[AUTHENTICATIONFAILED] invalid credentials"); continue; }
          authenticated = true;
          done("OK", "LOGIN completed");
          continue;
        }
        if (!authenticated) { done("NO", "not authenticated"); continue; }

        if (command === "LIST") {
          for (const folder of this.folders.values()) {
            const flags = ["\\HasNoChildren", ...folder.flags].join(" ");
            socket.write(`* LIST (${flags}) "/" "${folder.name}"${CRLF}`);
          }
          done("OK", "LIST completed");
          continue;
        }
        if (command === "EXAMINE" || command === "SELECT") {
          const name = unquote(args.join(" "));
          const folder = this.folders.get(name);
          if (!folder) { done("NO", "no such mailbox"); continue; }
          // Recorded so a test can prove the connector never issues SELECT,
          // which would set \Seen on the client's unread mail.
          selected = folder;
          socket.write(`* ${folder.messages.size} EXISTS${CRLF}`);
          socket.write(`* OK [UIDVALIDITY ${folder.uidvalidity}] UIDs valid${CRLF}`);
          socket.write(`* OK [UIDNEXT ${folder.nextUid}] Predicted next UID${CRLF}`);
          done("OK", "[READ-ONLY] EXAMINE completed");
          continue;
        }
        if (command === "UID") {
          const sub = (args[0] || "").toUpperCase();
          if (!selected) { done("NO", "no mailbox selected"); continue; }
          if (sub === "SEARCH") {
            const criteria = args.slice(1).join(" ").trim();
            let uids = selected.uids();
            const range = /^UID\s+(\d+):\*$/i.exec(criteria);
            if (range) {
              const low = Number(range[1]);
              const highest = uids.length ? uids[uids.length - 1] : 0;
              // RFC 3501 6.4.8: `n:*` returns at least the highest existing UID
              // even when n is past it. Reproduced exactly, because the client
              // filtering that away is the thing under test.
              uids = uids.filter((uid) => uid >= low);
              if (!uids.length && highest) uids = [highest];
            }
            socket.write(`* SEARCH${uids.length ? " " + uids.join(" ") : ""}${CRLF}`);
            done("OK", "UID SEARCH completed");
            continue;
          }
          if (sub === "FETCH") {
            if (this.failNextFetch) { this.failNextFetch = false; done("NO", "server error, try again"); continue; }
            const set = (args[1] || "").split(",").map(Number).filter(Boolean);
            const items = args.slice(2).join(" ").toUpperCase();
            const wantBody = items.includes("BODY.PEEK[]") || items.includes("BODY[]");
            const omitUid = Number(this.omitNextFetchUid);
            this.omitNextFetchUid = null;
            let seq = 0;
            for (const uid of set) {
              const message = selected.messages.get(uid);
              seq++;
              if (uid === omitUid) continue;
              if (!message) continue;
              const head =
                `* ${seq} FETCH (UID ${uid} INTERNALDATE "${message.internaldate}" RFC822.SIZE ${message.raw.length}`;
              if (!wantBody) { socket.write(`${head})${CRLF}`); continue; }
              socket.write(`${head} BODY[] {${message.raw.length}}${CRLF}`);
              socket.write(message.raw);
              socket.write(`)${CRLF}`);
            }
            done("OK", "UID FETCH completed");
            continue;
          }
          done("BAD", "unsupported UID subcommand");
          continue;
        }
        if (command === "NOOP") { done("OK", "NOOP completed"); continue; }
        if (command === "LOGOUT") {
          socket.write(`* BYE logging out${CRLF}`);
          done("OK", "LOGOUT completed");
          socket.end();
          continue;
        }
        done("BAD", `unknown command ${command}`);
      }
    });
    socket.on("error", () => { /* a test closing early is not a failure */ });
  }
}

function unquote(value) {
  const text = String(value ?? "");
  if (!text.startsWith('"')) return text;
  return text.slice(1, text.endsWith('"') ? -1 : undefined).replace(/\\(["\\])/g, "$1");
}
