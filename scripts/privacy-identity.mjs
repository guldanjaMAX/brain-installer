import { createHash } from "node:crypto";

// Privacy values are stored only as hashes of their normalized form. Short
// names remain guessable by dictionary, so this is an accident-prevention
// control rather than anonymization. Never replace these rows with plaintext.
export const IDENTITY_RULES = [
  { label: "owner first name", kind: "privacy", mode: "word", cs: false, words: 1, len: 5, fnv: 2953518059,
    sha: "119c9ae6f9ca741bd0a76f87fba0b22cab5413187afb2906aa2875c38e213603" },
  { label: "owner surname", kind: "privacy", mode: "word", cs: false, words: 1, len: 6, fnv: 2611250378,
    sha: "1afd80c4ad751e1bdd9b76ccd204676c1c02cbeb19764d6f3a04588aac5459d7" },
  { label: "owner organization", kind: "privacy", mode: "word", cs: false, words: 2, len: 12, fnv: 1585416513,
    sha: "b2163a788b89e956a5d1957910896b87ebe23f619a32d1c7b31c82a9073334e0" },
  // Case-sensitive because the lowercase form collides with an ordinary CSS
  // property word.
  { label: "owner organization short name", kind: "privacy", mode: "word", cs: true, words: 1, len: 5, fnv: 99079550,
    sha: "b1b1b4e5e8d796ce71667cf34f0aa7c824da30757b3ebd41c6aeb0645701d669" },
  { label: "owner personal domain", kind: "privacy", mode: "word", cs: false, words: 2, len: 15, fnv: 4039484157,
    sha: "371a0afcb0ba24194f53fe3624c9e04fcff01ac03bb0e8871da99e33cfcb8625" },
  { label: "owner personal domain host", kind: "privacy", mode: "any", cs: false, words: 1, len: 11, fnv: 364680288,
    sha: "6bd3a274516e9e4f240c6b38a1f4f5358afa5d11c1900e916d2eaae61266ea06" },
  { label: "collaborator first name", kind: "privacy", mode: "word", cs: false, words: 1, len: 3, fnv: 3572349335,
    sha: "bfef4adc39f01b033fe749bb5f28f10b581fef319d34445d21a7bc63fe732fa3" },
  { label: "collaborator surname", kind: "privacy", mode: "word", cs: false, words: 1, len: 6, fnv: 1854451012,
    sha: "e22608a909f233011372fd1af99d42faaa8446c083c31881397073f6f362770d" },
  { label: "collaborator client first name", kind: "privacy", mode: "word", cs: false, words: 1, len: 4, fnv: 2453857823,
    sha: "d0faf7d2e765298769fd7647ab532c80e828ff0dc2d8ee527646ef2ca4dacf64" },
  { label: "client first name", kind: "privacy", mode: "word", cs: false, words: 1, len: 3, fnv: 1669880439,
    sha: "27037fccea3062ee8ebaea07a9e2bf8dcb6511fd860ae993442aee0c512b8bbf" },
  { label: "client first name", kind: "privacy", mode: "word", cs: false, words: 1, len: 5, fnv: 3315428391,
    sha: "68d85a0a124d90d9eea4b9e3b436db429c8223911d52076d70aef4b78d9686c5" },
  { label: "family member first name", kind: "privacy", mode: "word", cs: false, words: 1, len: 6, fnv: 995860805,
    sha: "b675f2f6f1f675bb7be2e6694f55af82c76d063fcdf8c4606839d32bf505ef23" },
  { label: "cloudflare account id", kind: "privacy", mode: "any", cs: false, words: 1, len: 32, fnv: 3998430869,
    sha: "f36e60bbdd043ba7cceb8534ab1abde065257400d5bd16d4b117d120e923006d" },
  { label: "cloudflare account id prefix", kind: "privacy", mode: "word", cs: false, words: 1, len: 8, fnv: 577085071,
    sha: "9f749c653197b82589eeb38e164bcf02354f1d1cb97a764cfda84410a3f1624d" },
  { label: "cloudflare zone id", kind: "privacy", mode: "any", cs: false, words: 1, len: 32, fnv: 961214307,
    sha: "0268d272ca07074c10083014fc191b3d82cc3a2210f3142350e4424da34e47c2" },
  { label: "d1 database id", kind: "privacy", mode: "any", cs: false, words: 5, len: 36, fnv: 2969018041,
    sha: "2c1d79507808d15be2b2c89a21071596d86ebcc4b595a49e85d40a4d9acf1c57" },
  { label: "revoked cloudflare api token", kind: "known_revoked_credential", mode: "any", cs: false, words: 3, len: 40, fnv: 1957343082,
    sha: "e18efc466b9505d5355d4f575c4429fbd3a4180c9a8a7e8cc7cd5968828e3d88" },
  { label: "private repo commit sha", kind: "privacy", mode: "any", cs: false, words: 1, len: 40, fnv: 3046612968,
    sha: "8df85422477019b95adb54b74b34928beb64b540d3a96180a55c7a8a3bb3761c" },
  { label: "stripe product id", kind: "privacy", mode: "any", cs: false, words: 2, len: 19, fnv: 797592518,
    sha: "d084c80d7e62c37cf62ff21a3cd0588ab9aad710494ff93572a89c7f40142663" },
];

export const normalizeIdentityText = (text) => String(text).replace(/[^A-Za-z0-9]+/g, " ").trim();

export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export function compileIdentityRule(label, mode, cs, value, kind = "privacy") {
  const normalized = cs ? normalizeIdentityText(value) : normalizeIdentityText(value).toLowerCase();
  return {
    label,
    kind,
    mode,
    cs,
    words: normalized.split(" ").length,
    len: normalized.length,
    fnv: fnv1a(normalized),
    sha: sha256(normalized),
  };
}

export function buildIdentityIndex(rules = IDENTITY_RULES) {
  const index = {
    wordPrefilter: new Set(), wordDigests: new Map(), wordSizes: new Set(),
    anyPrefilter: new Set(), anyDigests: new Map(), anyLengths: new Set(),
  };
  for (const rule of rules) {
    if (rule.mode === "any" && rule.cs) {
      throw new Error(`rule "${rule.label}" cannot be both "any" and case-sensitive`);
    }
    if (!["privacy", "credential_candidate", "known_revoked_credential"].includes(rule.kind) ||
        !/^[0-9a-f]{64}$/.test(rule.sha) || !Number.isInteger(rule.fnv) ||
        rule.len < 1 || rule.words < 1) {
      throw new Error(`rule "${rule.label}" is malformed`);
    }
    const prefilter = rule.mode === "word" ? index.wordPrefilter : index.anyPrefilter;
    const digests = rule.mode === "word" ? index.wordDigests : index.anyDigests;
    const sizes = rule.mode === "word" ? index.wordSizes : index.anyLengths;
    prefilter.add(rule.fnv);
    digests.set(rule.sha, [...(digests.get(rule.sha) || []), {
      label: rule.label,
      kind: rule.kind,
    }]);
    sizes.add(rule.mode === "word" ? rule.words : rule.len);
  }
  index.wordSizes = [...index.wordSizes].sort((a, b) => a - b);
  index.anyLengths = [...index.anyLengths].sort((a, b) => a - b);
  return index;
}

export const IDENTITY_INDEX = buildIdentityIndex();

// The scanner returns categories only. It never returns, logs, or stores the
// matched text, which keeps a failure report from repeating the incident.
export function scanIdentityText(text, index = IDENTITY_INDEX) {
  const found = new Map();
  const normal = normalizeIdentityText(text);
  if (!normal) return [];
  const add = (candidate) => {
    for (const finding of candidate || []) {
      found.set(`${finding.kind}:${finding.label}`, finding);
    }
  };
  const words = normal.split(" ");
  for (let start = 0; start < words.length; start++) {
    for (const size of index.wordSizes) {
      if (start + size > words.length) break;
      const phrase = words.slice(start, start + size).join(" ");
      const folded = phrase.toLowerCase();
      for (const candidate of folded === phrase ? [phrase] : [phrase, folded]) {
        if (!index.wordPrefilter.has(fnv1a(candidate))) continue;
        add(index.wordDigests.get(sha256(candidate)));
      }
    }
  }
  if (index.anyLengths.length) {
    const lower = normal.toLowerCase();
    for (const length of index.anyLengths) {
      for (let start = 0; start + length <= lower.length; start++) {
        const window = lower.slice(start, start + length);
        if (!index.anyPrefilter.has(fnv1a(window))) continue;
        add(index.anyDigests.get(sha256(window)));
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

export function locateIdentityLines(text, index, findings) {
  const wanted = new Set(findings.map((finding) => `${finding.kind}:${finding.label}`));
  const located = new Map([...wanted].map((key) => [key, []]));
  String(text).split(/\r?\n/).forEach((line, offset) => {
    for (const finding of scanIdentityText(line, index)) {
      const key = `${finding.kind}:${finding.label}`;
      if (located.has(key)) located.get(key).push(offset + 1);
    }
  });
  return located;
}

export function safeIdentifier(value, prefix = "redacted") {
  const findings = scanIdentityText(value);
  return findings.length ? `[${prefix}:${sha256(String(value)).slice(0, 12)}]` : String(value);
}
