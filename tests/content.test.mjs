import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public page includes its required Chinese download-site content", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<html\s+lang="zh-CN">/);
  assert.equal(html.match(/<h1>AI XMP Tagger<\/h1>/g)?.length, 1);
  assert.match(html, /id="downloads"/);
  assert.match(html, /非 Amazon 官方产品/);
});
