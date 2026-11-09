const http = require("http");

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/healthz") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "ok", service: "mock-game" }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(4020, "0.0.0.0", () => {
  console.log("Mock Game running on port 4020");
});