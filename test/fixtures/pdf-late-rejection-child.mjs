process.stdout.write(`${JSON.stringify({ type: "ready", version: 1 })}\n`);

const error = new Error("Bad (uncompressed) XRef entry: 24R");
error.name = "UnknownErrorException";
Promise.reject(error);

setTimeout(() => {
  process.stdout.write(JSON.stringify({ ok: true, text: "this result must not escape", totalPages: 1 }));
}, 25);
