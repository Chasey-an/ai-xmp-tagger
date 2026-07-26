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

const server = createServer(async (req, res) => {
  try {
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
    const cacheControl = relativePath.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : extension === ".html"
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=0, must-revalidate";
    const headers = {
      "cache-control": cacheControl,
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

const port = Number.parseInt(process.env.PORT ?? "4173", 10);
server.listen(port, "127.0.0.1", () => {
  console.log(`CSP test server listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
