import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const distRoot = path.join(repositoryRoot, "dist");
const netlifyConfig = await readFile(
  path.join(repositoryRoot, "netlify.toml"),
  "utf8",
);

function requiredHeader(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = netlifyConfig.match(
    new RegExp(`^\\s+${escaped} = "([^"]+)"$`, "m"),
  )?.[1];
  if (value === undefined) {
    throw new Error(`Missing ${name} in netlify.toml`);
  }
  return value;
}

const globalHeaders = {
  "content-security-policy": requiredHeader("Content-Security-Policy"),
  "permissions-policy": requiredHeader("Permissions-Policy"),
  "referrer-policy": requiredHeader("Referrer-Policy"),
  "x-content-type-options": requiredHeader("X-Content-Type-Options"),
};

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...globalHeaders,
    ...headers,
  });
  res.end(body);
}

function createCspServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, "Method Not Allowed", { allow: "GET, HEAD" });
        return;
      }
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const requestedPath =
        requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const relativePath = decodeURIComponent(requestedPath).replace(/^\/+/u, "");
      const absolutePath = path.resolve(distRoot, relativePath);
      if (
        absolutePath !== distRoot &&
        !absolutePath.startsWith(`${distRoot}${path.sep}`)
      ) {
        send(res, 403, "Forbidden");
        return;
      }

      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        send(res, 404, "Not Found");
        return;
      }

      const extension = path.extname(absolutePath).toLowerCase();
      const headers = {
        "cache-control": relativePath.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
        "content-type":
          MIME_TYPES.get(extension) ?? "application/octet-stream",
      };
      if (req.method === "HEAD") {
        send(res, 200, "", headers);
        return;
      }
      send(res, 200, await readFile(absolutePath), headers);
    } catch (error) {
      const status =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
          ? 404
          : 500;
      send(res, status, status === 404 ? "Not Found" : "Internal Server Error");
    }
  });
}

export async function startCspServer({ port = 4173 } = {}) {
  const server = createCspServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("CSP test server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  const requestedPort = Number.parseInt(process.env.PORT ?? "4173", 10);
  const runningServer = await startCspServer({ port: requestedPort });
  console.log(`CSP test server listening on ${runningServer.url}`);

  async function shutdown() {
    await runningServer.close();
    process.exit(0);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
