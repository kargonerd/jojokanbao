import { createServer } from "node:http";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(option("--port", "6699"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("A valid --port is required");
}

const server = createServer((_request, response) => {
  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "JOJO backend routes are served by Makers Functions" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`JOJO backend placeholder listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
