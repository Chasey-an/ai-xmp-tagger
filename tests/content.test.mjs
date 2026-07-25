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
  assert.match(html, /已实际验证 500 张图片/);
  assert.match(html, /更大的任务建议按 500–1,000 张分批/);
  assert.match(
    html,
    /未另选位置时，输出在源文件旁的 <code>Amazon_XMP_Output<\/code> 文件夹/,
  );
});

test("page exposes the planned styling hooks and download hierarchy", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  for (const className of [
    "site-header",
    "brand",
    "brand-mark",
    "hero",
    "hero-copy",
    "hero-preview",
    "download-actions",
    "beta-warning",
    "section",
    "screenshot-grid",
    "card-grid",
    "steps",
    "privacy-panel",
    "install-grid",
    "final-download",
    "site-footer",
  ]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`));
  }

  assert.match(
    html,
    /class="button button-primary" href="@@MAC_ARM64_URL@@"/,
  );
  assert.match(
    html,
    /class="button button-primary" href="@@WINDOWS_X64_URL@@"/,
  );
  assert.match(html, /class="text-link" href="@@MAC_X64_URL@@"/);
  assert.match(html, /<span>v@@VERSION@@<\/span>/);
  assert.match(html, /自己站点卖家平台的最新通知/);
});

test("download areas use the prescribed platform labels", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.equal(
    html.match(/>下载 Mac 版（Apple 芯片）<\/a>/g)?.length,
    2,
  );
  assert.equal(
    html.match(/>下载 Windows 版（64 位）<\/a>/g)?.length,
    2,
  );
  assert.match(
    html,
    /class="text-link" href="@@MAC_X64_URL@@">Intel Mac 下载<\/a>/,
  );
  assert.match(
    html,
    /class="text-link" href="@@RELEASES_URL@@">查看全部版本<\/a>/,
  );
});

test("mode cards and workflow preserve their visible semantic numbers", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  for (const [number, heading] of [
    ["01", "高清 JPG＋写入 XMP"],
    ["02", "保留原格式＋写入 XMP"],
    ["03", "仅检查 XMP"],
  ]) {
    assert.match(
      html,
      new RegExp(
        `<article>\\s*<p class="card-number">${number}</p>\\s*<h3>${heading}</h3>`,
      ),
    );
  }

  const workflow = html.match(
    /<section[^>]*id="workflow"[^>]*>([\s\S]*?)<\/section>/,
  )?.[1];
  assert.ok(workflow);
  assert.equal(workflow.match(/<li>\s*<span>[1-6]<\/span>\s*<p>/g)?.length, 6);
  for (let number = 1; number <= 6; number += 1) {
    assert.match(
      workflow,
      new RegExp(
        `<li>\\s*<span>${number}</span>\\s*<p>[\\s\\S]*?</p>\\s*</li>`,
      ),
    );
  }
});

test("every instructional section starts with its planned eyebrow", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  for (const [id, label] of [
    ["policy", "先确认是否适用"],
    ["screenshots", "真实使用过程"],
    ["modes", "三种模式"],
    ["workflow", "使用过程"],
    ["privacy", "隐私与文件安全"],
    ["install", "公开测试版"],
    ["faq", "常见问题"],
  ]) {
    assert.match(
      html,
      new RegExp(
        `<section[^>]*id="${id}"[^>]*>\\s*<p class="eyebrow">${label}</p>\\s*<h2`,
      ),
    );
  }
});

test("unsigned-install guidance requires SHA-256 verification without disabling protections", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.ok((html.match(/SHA-256/g) ?? []).length >= 4);
  assert.match(
    html,
    /<p class="beta-warning"[\s\S]*?核对下载来源、文件名和 SHA-256[\s\S]*?<\/p>/,
  );
  assert.match(
    html,
    /<h3>macOS<\/h3>[\s\S]*?核对下载来源、文件名和 SHA-256[\s\S]*?<\/article>/,
  );
  assert.match(
    html,
    /<h3>Windows<\/h3>[\s\S]*?核对下载来源、文件名和 SHA-256[\s\S]*?<\/article>/,
  );
  assert.match(
    html,
    /为什么系统提示无法验证开发者[\s\S]*?核对下载来源、文件名和 SHA-256[\s\S]*?<\/details>/,
  );
  assert.match(html, /切勿为了运行本工具而关闭 Gatekeeper、SmartScreen/);
});

test("document head declares the favicon MIME type", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(
    html,
    /<link rel="icon" href="\.\/favicon\.svg" type="image\/svg\+xml">/,
  );
});

test("favicon provides the standalone XMP mark", async () => {
  const favicon = await readFile(
    new URL("../public/favicon.svg", import.meta.url),
    "utf8",
  );

  assert.match(favicon, /viewBox="0 0 64 64"/);
  assert.match(favicon, />XMP</);
});
