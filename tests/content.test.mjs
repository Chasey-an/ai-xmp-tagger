import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public page includes its required Chinese download-site content", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<html\s+lang="zh-CN">/);
  assert.equal(html.match(/<h1\b[^>]*>/g)?.length, 1);
  assert.match(html, /<h1\b[^>]*>AI XMP Tagger<\/h1>/);
  assert.match(html, /id="downloads"/);
  assert.match(html, /非 Amazon 官方产品/);
});

test("public page exposes every required product and policy section", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  for (const sectionId of [
    "policy",
    "screenshots",
    "modes",
    "workflow",
    "privacy",
    "install",
    "faq",
  ]) {
    assert.match(html, new RegExp(`id="${sectionId}"`));
  }
});

test("public page states the required XMP, mode, privacy, install, and FAQ contracts", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  for (const requiredCopy of [
    "contains-synthetic-performer",
    "XMP <code>dc:subject</code>",
    "高清 JPG＋写入 XMP",
    "保留原格式＋写入 XMP",
    "仅检查 XMP",
    "不上传图片或路径",
    "安装包暂未签名",
    "本工具不会判断图片是不是 AI 生成",
    "为什么系统提示无法验证开发者",
    "工具会自动判断图片是不是 AI 生成吗",
    "确认素材确实包含 AI 生成人物",
    "独立工具，非 Amazon 官方产品。",
  ]) {
    assert.match(html, new RegExp(requiredCopy));
  }
});

test("FAQ documents supported formats and practical batch limits", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(
    html,
    /支持 JPG\/JPEG、PNG、WebP、HEIC\/HEIF、TIF\/TIFF 和 BMP/,
  );
  assert.match(html, /没有设置文件夹 GB 上限/);
  assert.match(html, /已验证单次处理 500 个文件/);
  assert.match(html, /500–1000 个/);
});

test("favicon provides the standalone XMP mark", async () => {
  const favicon = await readFile(
    new URL("../public/favicon.svg", import.meta.url),
    "utf8",
  );

  assert.match(favicon, /viewBox="0 0 64 64"/);
  assert.match(favicon, />XMP</);
});
