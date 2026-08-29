// EVERY credential, id, host and name below is INVENTED, and must stay that
// way. A gate that refuses real secrets can only be exercised with
// secret-SHAPED inputs, which makes this the one file in the repo where
// pasting a real value feels like the quickest way to get a fixture. Never do
// it: this repo is public, and fixtures get copied, quoted and grepped far
// more often than they get read.
//
// When a fixture needs to change, keep the SHAPE and invent the value: same
// prefix, same length, same character class, same casing mix. The assertions
// here turn on shape (40 chars, 32 hex, uuid segments, provider prefix), not
// on any particular secret, so a synthetic value proves exactly as much and is
// worthless if it leaks. People are personas, hosts are *.example.test.

import {
  scan, scanEnvelope, redact, sanitizeEnvelope, sanitizeSensitiveLinks,
  hasSensitiveTransportIdentity, SENSITIVE_LINK_REDACTION,
  CONFIRMED, SUSPECTED, CLEAN, GATE_VERSION,
} from "../src/lib/secret-scan.js";
let fail = 0;
const chk = (n, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

// Must REFUSE. Every value in both tables below is invented; see the header.
// Keep it that way when you edit one: the shape is what is under test.
for (const [n, t] of [
  ["classic CF in doc", "| Cloudflare API Token (Read/D1) | FIXTURE0CFTOKEN0SYNTHETIC0NOTAREALKEY001 |"],
  ["CF env token", "CLOUDFLARE_API_TOKEN=FIXTURE0CFTOKEN0SYNTHETIC0NOTAREALKEY001"],
  ["resend inner underscore", "Bearer re_2QKY3kyq_AbCdEfGhIjKlMnOpQrStUvWx"],
  ["postgres dsn", "postgres://postgres.abc:sup3rS3cretPassw0rd@aws-1.pooler.supabase.com:5432/postgres"],
  ["query token", "https://esignatures.io/api/contracts?token=9f2b7c4a1e8d3600bc5a9e2f7d4b1c86"],
  ["pem header alone", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow..."],
  ["anthropic", "sk-ant-api03-Xq7fLm2pRtYv9wBn4KdZs8HjE6cAuG1i"],
  ["supabase pat", "sbp_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"],
  ["google key", "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"],
  ["stripe whsec", "whsec_AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
  ["notion", "ntn_1234567890abcdefghijklmnopqrstuvwxyzABCDEF"],
]) chk("refuse: " + n, scan(t).verdict === CONFIRMED, JSON.stringify(scan(t).labels));

// Must stay CLEAN.
for (const [n, t] of [
  ["cf account id", "Cloudflare Account ID: 0123456789abcdef0123456789abcdef"],
  ["zone id row", "| Cloudflare Zone: brand.example.test | Zone ID abcdef0123456789abcdef0123456789 |"],
  ["git sha", "commit 0123456789abcdef0123456789abcdef01234567 shipped"],
  ["d1 uuid", "D1 Database ID | 11111111-2222-3333-4444-555555555555"],
  ["keychain idiom", 'Bearer $(security find-generic-password -a x -s y -w)'],
  ["placeholder", "Bearer YOUR_API_KEY_HERE_REPLACE"],
  ["tracking link", "https://t.co/aQYR-r8_1uzsfdsFklmnopqrstuvwxyz01"],
  ["underscore words", "the share_link and signature_block and picture_frame"],
  ["prose", "Priya Nair flagged the spring workshop needs a waitlist first."],
  ["stripe product", "Starter Plan | prod_Sy7Fixture0Abc | $19"],
]) chk("clean: " + n, scan(t).verdict === CLEAN, JSON.stringify(scan(t).labels));

// lastIndex reuse: global regexes must not skip on repeat calls.
const s = "sbp_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
chk("repeat 1", scan(s).verdict === CONFIRMED);
chk("repeat 2", scan(s).verdict === CONFIRMED);
chk("repeat 3", scan(s).verdict === CONFIRMED);

// redaction
const r = redact("k=re_2QKY3kyq_AbCdEfGhIjKlMnOpQrStUvWx done");
chk("redact removes", !r.includes("2QKY3kyq"), r);
chk("redact labels", r.includes("[REDACTED:"), r);
chk("redact keeps public id", redact("zone abcdef0123456789abcdef0123456789") === "zone abcdef0123456789abcdef0123456789");
chk("preview never leaks", !JSON.stringify(scan(s).findings).includes("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"));
chk("empty", scan("").verdict === CLEAN);
chk("null", scan(null).verdict === CLEAN);

const envelopeSecret = `sk-proj-${"A7".repeat(16)}`;
chk("envelope title is scanned",
  scanEnvelope({ content: "ordinary prose", title: `credentials ${envelopeSecret}` }).shouldRefuse);
chk("envelope path metadata is scanned",
  scanEnvelope({ content: "ordinary prose", metadata: { folder: `Imports/${envelopeSecret}/Notes` } }).shouldRefuse);
chk("envelope fields are never concatenated into a synthetic credential",
  scanEnvelope({ title: "sk-proj-", content: "A7".repeat(16) }).verdict === CLEAN);
const paymentToken = "Xy7Ab9".repeat(8);
for (const [name, url] of [
  ["hosted invoice", `https://invoice.stripe.com/i/acct_fixture123/test_${paymentToken}?s=em`],
  ["invoice PDF", `https://pay.stripe.com/invoice/acct_fixture123/live_${paymentToken}/pdf?s=ap`],
  ["billing portal", `https://billing.stripe.com/p/session/test_${paymentToken}`],
  ["hosted Checkout", `https://checkout.stripe.com/c/pay/cs_live_${paymentToken}#fidfixture`],
  ["custom-domain Checkout", `https://pay.example.invalid/c/pay/cs_test_${paymentToken}#fidfixture`],
]) {
  const sanitized = sanitizeSensitiveLinks(`Invoice remains due Friday. ${url} Please follow up.`);
  chk(`${name} capability URL is replaced`,
    sanitized === `Invoice remains due Friday. ${SENSITIVE_LINK_REDACTION} Please follow up.`);
  chk(`${name} token is absent after replacement`, !sanitized.includes(paymentToken));
}

const publicPaymentLink = "https://buy.stripe.com/test_fixture123?prefilled_email=client%40example.invalid";
chk("public reusable Stripe Payment Link remains searchable",
  sanitizeSensitiveLinks(`Use ${publicPaymentLink}`) === `Use ${publicPaymentLink}`);

const privateInvoiceUrl = `https://invoice.stripe.com/i/acct_fixture123/test_${paymentToken}`;
const sensitiveEnvelope = sanitizeEnvelope({
  source_type: "message",
  source_id: `stable-${paymentToken}`,
  title: `Invoice ${privateInvoiceUrl}`,
  content: `Billing is active. https://billing.stripe.com/p/session/test_${paymentToken} Follow up Friday.`,
  uri: `https://pay.example.invalid/c/pay/cs_live_${paymentToken}`,
  date_source: `Imported from ${privateInvoiceUrl}`,
  source_subtype: `legacy billing ${privateInvoiceUrl}`,
  arbitrary_persisted_field: `Safe prefix ${privateInvoiceUrl} safe suffix`,
  metadata: {
    nested: [`https://pay.stripe.com/invoice/acct_fixture123/test_${paymentToken}/pdf`],
    [`private lookup ${privateInvoiceUrl}`]: { useful: "billing note survives" },
  },
});
chk("envelope sanitization preserves transport identity",
  sensitiveEnvelope.source_type === "message" && sensitiveEnvelope.source_id === `stable-${paymentToken}`);
chk("a capability URL in transport identity is detected for fail-closed refusal",
  hasSensitiveTransportIdentity({ source_type: "message", source_id: `https://invoice.stripe.com/i/acct_fixture123/live_${paymentToken}` }));
chk("a nested capability URL cannot evade transport-identity refusal",
  hasSensitiveTransportIdentity({
    source_type: "message",
    source_id: { nested: `https://invoice.stripe.com/i/acct_fixture123/live_${paymentToken}` },
  }));
chk("envelope sanitization covers every searchable field",
  !JSON.stringify({
    title: sensitiveEnvelope.title,
    content: sensitiveEnvelope.content,
    uri: sensitiveEnvelope.uri,
    date_source: sensitiveEnvelope.date_source,
    source_subtype: sensitiveEnvelope.source_subtype,
    arbitrary_persisted_field: sensitiveEnvelope.arbitrary_persisted_field,
    metadata: sensitiveEnvelope.metadata,
  }).includes(paymentToken));
chk("nested metadata keys are sanitized without dropping their useful value",
  !Object.keys(sensitiveEnvelope.metadata).join("\n").includes(paymentToken) &&
    JSON.stringify(sensitiveEnvelope.metadata).includes("billing note survives"));
chk("date_source and legacy source_subtype are sanitized",
  sensitiveEnvelope.date_source.includes(SENSITIVE_LINK_REDACTION) &&
    sensitiveEnvelope.source_subtype.includes(SENSITIVE_LINK_REDACTION));
chk("arbitrary persisted fields are sanitized",
  sensitiveEnvelope.arbitrary_persisted_field ===
    `Safe prefix ${SENSITIVE_LINK_REDACTION} safe suffix`);
chk("useful billing prose survives envelope sanitization",
  sensitiveEnvelope.content.includes("Billing is active.") && sensitiveEnvelope.content.includes("Follow up Friday."));
chk("sanitized capability markers are clean to the refusal scanner",
  scanEnvelope(sensitiveEnvelope).verdict === CLEAN);
chk("capability-link safety advances the durable gate version", GATE_VERSION === 4, String(GATE_VERSION));

console.log(fail ? `\n${fail} FAILURES` : "\nsecret-scan v4 (js): all tests passed");
process.exit(fail ? 1 : 0);
