process.stdout.write(`${JSON.stringify({ type: "ready", version: 1 })}\n`);

process.stdout.write(JSON.stringify({ ok: true, text: { unexpected: true }, totalPages: "one" }));
