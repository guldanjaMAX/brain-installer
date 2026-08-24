process.stdout.write(`${JSON.stringify({ type: "ready", version: 1 })}\n`);

process.stdout.write(JSON.stringify({ ok: true, text: "false success", totalPages: 1 }));

setImmediate(() => {
  const error = new Error("Bad (uncompressed) XRef entry: 24R");
  error.name = "UnknownErrorException";
  Promise.reject(error);
});
