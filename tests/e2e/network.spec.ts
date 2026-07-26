import { expect, test } from "@playwright/test";

import {
  fixtureBytes,
  processUploaded,
} from "./helpers";

declare global {
  interface Window {
    __networkApiCalls?: string[];
  }
}

test("processing sends no image, filename or application request off the local origin", async ({
  page,
  context,
}) => {
  const sentinelFilename = "private-sentinel-7f56c9.png";
  const sentinelContent = "SENTINEL_IMAGE_BYTES_7f56c9";
  const requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postData: string | null;
  }> = [];
  const consoleMessages: string[] = [];

  await page.addInitScript(() => {
    const calls: string[] = [];
    window.__networkApiCalls = calls;
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      calls.push(`fetch:${String(args[0])}`);
      return originalFetch(...args);
    };
    const originalOpen = XMLHttpRequest.prototype.open as (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async: boolean,
      username?: string | null,
      password?: string | null,
    ) => void;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ) {
      calls.push(`xhr:${String(url)}`);
      return originalOpen.call(this, method, url, async, username, password);
    };
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (...args) => {
      calls.push(`beacon:${String(args[0])}`);
      return originalBeacon(...args);
    };
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        calls.push(`websocket:${String(args[0])}`);
        return Reflect.construct(target, args);
      },
    });
    if ("EventSource" in window) {
      const OriginalEventSource = window.EventSource;
      window.EventSource = new Proxy(OriginalEventSource, {
        construct(target, args) {
          calls.push(`eventsource:${String(args[0])}`);
          return Reflect.construct(target, args);
        },
      });
    }
  });
  page.on("console", (message) => consoleMessages.push(message.text()));

  await page.goto("/");
  page.on("request", (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData(),
    });
  });

  const source = await fixtureBytes("neutral-1x1.png");
  const sentinelBytes = Buffer.concat([
    source.subarray(0, source.length - 12),
    pngTextChunk("Comment", sentinelContent),
    source.subarray(source.length - 12),
  ]);
  await page.getByLabel("选择图片文件", { exact: true }).setInputFiles({
    name: sentinelFilename,
    mimeType: "image/png",
    buffer: sentinelBytes,
  });
  await expect(page.getByRole("button", { name: "开始处理" })).toBeEnabled();
  await processUploaded(page);

  expect(await page.evaluate(() => window.__networkApiCalls ?? [])).toEqual([]);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const request of requests) {
    const url = new URL(request.url);
    expect(url.origin).toBe("http://127.0.0.1:4173");
    expect(["GET", "HEAD"]).toContain(request.method);
    expect(url.search).toBe("");
    expect(url.pathname).toMatch(
      /^\/assets\/(?:process\.worker-[^/]+\.js|[^/]+\.wasm)$/u,
    );
    expect(request.postData).toBeNull();
  }
  expect(requests.some(({ url }) => url.endsWith(".wasm"))).toBe(true);
  expect(requests.some(({ url }) => /process\.worker-[^/]+\.js$/u.test(url))).toBe(
    true,
  );

  const requestEvidence = JSON.stringify(requests);
  const consoleEvidence = consoleMessages.join("\n");
  for (const sentinel of [sentinelFilename, sentinelContent]) {
    expect(requestEvidence).not.toContain(sentinel);
    expect(consoleEvidence).not.toContain(sentinel);
  }

  const storageEvidence = await page.evaluate(async () => {
    const indexedDatabases =
      typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : [];
    const cacheNames = "caches" in window ? await caches.keys() : [];
    const registrations =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistrations()
        : [];
    return {
      local: { ...localStorage },
      session: { ...sessionStorage },
      indexedDatabases,
      cacheNames,
      serviceWorkers: registrations.map(({ scope }) => scope),
    };
  });
  expect(JSON.stringify(storageEvidence)).not.toContain(sentinelFilename);
  expect(JSON.stringify(storageEvidence)).not.toContain(sentinelContent);
  expect(storageEvidence).toEqual({
    local: {},
    session: {},
    indexedDatabases: [],
    cacheNames: [],
    serviceWorkers: [],
  });

  const cookies = await context.cookies("http://127.0.0.1:4173");
  expect(cookies).toEqual([]);
});

function pngTextChunk(keyword: string, text: string): Buffer {
  const type = Buffer.from("tEXt");
  const data = Buffer.from(`${keyword}\0${text}`, "latin1");
  const body = Buffer.concat([type, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), 8 + data.length);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
