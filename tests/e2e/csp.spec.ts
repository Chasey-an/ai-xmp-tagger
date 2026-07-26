import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { processUploaded, upload } from "./helpers";

async function textFiles(
  root: string,
  extensions: ReadonlySet<string>,
): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await textFiles(target, extensions)));
    } else if (extensions.has(path.extname(entry.name))) {
      output.push(await readFile(target, "utf8"));
    }
  }
  return output;
}

test("production sources and build declare no external runtime connections", async () => {
  const sourceTexts = await textFiles("src", new Set([".css", ".ts", ".tsx"]));
  sourceTexts.push(await readFile("index.html", "utf8"));
  const source = sourceTexts.join("\n");
  const dist = (
    await textFiles("dist", new Set([".css", ".html", ".js"]))
  ).join("\n");

  expect(source).not.toMatch(
    /\b(?:fetch|sendBeacon)\s*\(|\b(?:XMLHttpRequest|WebSocket|EventSource)\b/u,
  );
  expect(dist).not.toMatch(
    /(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/|\b(?:fetch|open)\s*\(\s*["'`]https?:\/\/|new\s+(?:WebSocket|EventSource)\s*\(\s*["'`]https?:\/\//iu,
  );
  expect(await readdir("dist/assets")).toEqual(
    expect.arrayContaining([expect.stringMatching(/\.wasm$/u)]),
  );
});

test("production CSP permits only same-origin WASM conversion requests", async ({
  page,
}) => {
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];
  const networkUrls: URL[] = [];
  const responseHeaders = new Map<string, Record<string, string>>();

  page.on("console", (message) => {
    if (
      /content security policy|refused to (?:connect|load|execute|create)/iu.test(
        message.text(),
      )
    ) {
      cspViolations.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      networkUrls.push(url);
    }
  });
  page.on("response", (response) => {
    responseHeaders.set(new URL(response.url()).pathname, response.headers());
  });

  const documentResponse = await page.goto("/");
  expect(documentResponse).not.toBeNull();
  const documentHeaders = documentResponse!.headers();
  expect(documentHeaders["content-security-policy"]).toContain(
    "connect-src 'self'",
  );
  expect(documentHeaders["content-security-policy"]).not.toMatch(
    /connect-src[^;]*(?:https?:|data:|blob:)/u,
  );
  expect(documentHeaders["x-content-type-options"]).toBe("nosniff");
  expect(documentHeaders["cache-control"]).toBe(
    "public, max-age=0, must-revalidate",
  );

  await upload(page, ["neutral-1x1.png"]);
  await processUploaded(page);

  const resultRow = page.locator("tbody tr").filter({
    hasText: "neutral-1x1.png",
  });
  await expect(resultRow).toContainText("✓ 成功");
  await expect(resultRow).toContainText("✓ 包含");

  const wasmUrl = networkUrls.find(({ pathname }) => pathname.endsWith(".wasm"));
  expect(wasmUrl, "conversion must fetch the production MozJPEG WASM").toBeDefined();
  const workerUrl = networkUrls.find(({ pathname }) =>
    /\/assets\/process\.worker-[^/]+\.js$/u.test(pathname),
  );
  expect(workerUrl, "processing must load the production worker").toBeDefined();
  const applicationUrl = networkUrls.find(({ pathname }) =>
    /\/assets\/index-[^/]+\.js$/u.test(pathname),
  );
  expect(applicationUrl, "the production application bundle must load").toBeDefined();
  expect(responseHeaders.has(wasmUrl!.pathname)).toBe(true);
  expect(responseHeaders.has(workerUrl!.pathname)).toBe(true);
  expect(responseHeaders.has(applicationUrl!.pathname)).toBe(true);
  expect(responseHeaders.get(wasmUrl!.pathname)?.["content-type"]).toBe(
    "application/wasm",
  );
  expect(responseHeaders.get(workerUrl!.pathname)?.["content-type"]).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(responseHeaders.get(applicationUrl!.pathname)?.["content-type"]).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(responseHeaders.get(wasmUrl!.pathname)?.["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect([...new Set(networkUrls.map(({ host }) => host))]).toEqual([
    "127.0.0.1:4173",
  ]);
  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
});
