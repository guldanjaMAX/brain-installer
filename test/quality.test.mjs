import { textQuality, isLikelyBinary, stripMarkup, MIN_CHARS } from "../ingest/quality.mjs";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

const PROSE = "We agreed to defer the retainer increase until October, and to revisit the coverage register before the quarterly review. Brian will send the updated schedule.";

/* ---- real text must pass. A false reject silently loses a document. ---- */
check("ordinary prose passes", textQuality(PROSE).ok);
check("a short but real note passes", textQuality("Call Eli about the AMS pricing change tomorrow.").ok);
check("prose that MENTIONS a token is not junk",
  textQuality(PROSE + " The key was rotated: sk-live-abcdefghijklmnop.").ok);
check("a table of numbers is still text", textQuality(
  ["Account,Balance", "Checking,15234.11", "Savings,80100.00", "Loan,-42311.87"].join("\n") + "\n" + PROSE).ok);

/* ---- the case this was built for ---- */
{
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" .repeat(60);
  const r = textQuality(`<img src="data:image/png;base64,${b64}">` + " a caption");
  check("a file that is mostly base64 is rejected", !r.ok, JSON.stringify(r.metrics));
  check("and the reason is legible to a client", /encoded data/.test(r.reason || ""), r.reason);
  check("with the ratio recorded", r.metrics.encoded_ratio > 0.35, JSON.stringify(r.metrics));
}
{
  const r = textQuality("BEGIN CERT " + "a1b2c3d4e5f6".repeat(40) + " END");
  check("a long hex blob is rejected", !r.ok, JSON.stringify(r.metrics));
}

/* ---- failed extraction must not enter as an empty document ---- */
check("empty text is rejected", !textQuality("").ok);
check("whitespace only is rejected", !textQuality("   \n\t  ").ok);
check("below the floor is rejected", !textQuality("x".repeat(MIN_CHARS - 1)).ok);
check("the empty-extraction message names the real cause", /empty result/.test(textQuality("").reason));
check("a bad decode is rejected", !textQuality("�".repeat(100) + " some text here to pad it out").ok);

/* ---- repetition, but only where it is genuinely pathological ---- */
{
  const r = textQuality("row,1,ok\n".repeat(900));
  check("a giant file of one repeated row is rejected", !r.ok, JSON.stringify(r.metrics));
  const varied = Array.from({ length: 900 }, (_, i) => `invoice ${i} client acme amount ${i * 37} status paid`).join("\n");
  check("a large file with genuinely varied rows passes", textQuality(varied).ok, JSON.stringify(textQuality(varied).metrics));
  check("a SHORT repetitive note is not judged", textQuality("ok ok ok ok ok ok ok ok ok ok").ok);
}

/* ---- binary detection runs on raw bytes ---- */
check("a NUL byte marks it binary", isLikelyBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41])));
check("plain ascii is not binary", !isLikelyBinary(Buffer.from(PROSE, "utf8")));
check("utf8 accents are not binary", !isLikelyBinary(Buffer.from("café résumé naïve — dash", "utf8")));
check("tabs and newlines are not binary", !isLikelyBinary(Buffer.from("a\tb\r\nc\n", "utf8")));
check("empty buffer is not binary", !isLikelyBinary(Buffer.alloc(0)));

/* ---- markup stripping ---- */
{
  const html = `<html><head><style>body{color:red}</style><script>var x=1;</script></head>
    <body><!-- hidden --><h1>Q3 Review</h1><p>We agreed to &amp; then defer.</p><ul><li>One</li><li>Two</li></ul></body></html>`;
  const t = stripMarkup(html);
  check("script contents are removed", !/var x/.test(t), t);
  check("style contents are removed", !/color:red/.test(t), t);
  check("comments are removed", !/hidden/.test(t), t);
  check("visible text survives", /Q3 Review/.test(t) && /defer/.test(t), t);
  check("entities are decoded", /& then/.test(t), t);
  check("block elements become line breaks", /One\s*\n\s*Two/.test(t), JSON.stringify(t));
}

console.log(fail ? `\n${fail} FAILURES` : `\nquality: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
