process.stdout.write(`${JSON.stringify({ type: "ready", version: 1 })}\n`);

process.stdin.resume();
setInterval(() => {}, 1_000);
