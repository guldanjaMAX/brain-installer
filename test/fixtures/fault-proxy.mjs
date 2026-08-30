import { createServer as createHttpServer } from "node:http";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const close = (server, sockets) => new Promise((resolve) => {
  for (const socket of sockets) socket.destroy();
  server.close(() => resolve());
});

export async function createLocalJsonFixture() {
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    if (request.url === "/retry-after") {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "3" });
      response.end(JSON.stringify({ error: "synthetic_throttle" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, fixture: "local" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => close(server, sockets),
  };
}

/** A local TCP fault injector with a deliberately small Toxiproxy-like API. */
export async function createFaultProxy({ upstreamPort, mode = "pass", latencyMs = 0 } = {}) {
  const sockets = new Set();
  let activeMode = mode;
  let activeLatency = latencyMs;
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    if (activeMode === "reset") {
      client.destroy(new Error("synthetic reset"));
      return;
    }
    if (activeMode === "malformed_json") {
      client.once("data", () => {
        client.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9\r\nConnection: close\r\n\r\n{not-json");
      });
      return;
    }
    if (activeMode === "half_response") {
      client.once("data", () => {
        client.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 80\r\nConnection: close\r\n\r\n{\"partial\":");
        setTimeout(() => client.destroy(), 5);
      });
      return;
    }
    if (activeMode === "retry_after") {
      client.once("data", () => {
        const body = "{\"error\":\"synthetic_throttle\"}";
        client.end(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 3\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      });
      return;
    }
    const connect = () => {
      const upstream = connectTcp({ host: "127.0.0.1", port: upstreamPort });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    };
    if (activeMode === "latency" && activeLatency > 0) setTimeout(connect, activeLatency);
    else connect();
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    setMode(next, options = {}) {
      for (const socket of sockets) socket.destroy();
      activeMode = next;
      activeLatency = Number(options.latencyMs || 0);
    },
    close: () => close(server, sockets),
  };
}
