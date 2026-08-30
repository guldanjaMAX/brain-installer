process.stdout.write(`${JSON.stringify({ type: "ready", version: 1 })}\n`);

let bytes = 0;
for await (const chunk of process.stdin) bytes += chunk.length;

const leaked = Boolean(process.env.BRAIN_PDF_TEST_SECRET);
process.stdout.write(JSON.stringify({
  ok: true,
  text: `isolated ${bytes} bytes ${leaked ? "leaked" : "clean"}`,
  totalPages: 1,
}));
