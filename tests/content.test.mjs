import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateReleaseManifest } from "../release-manifest.mjs";

const projectDirectory = new URL("../", import.meta.url);

async function listSourceFiles(directoryUrl, excludedNames = new Set()) {
  const files = [];
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) {
      continue;
    }

    const entryUrl = new URL(entry.name, directoryUrl);
    if (entry.isDirectory()) {
      files.push(
        ...(await listSourceFiles(
          new URL(`${entry.name}/`, directoryUrl),
          excludedNames,
        )),
      );
    } else if (/\.(?:html|js|mjs|css)$/.test(entry.name)) {
      files.push(entryUrl);
    }
  }
  return files;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("release manifest defines the verified v0.1.0 assets in platform order", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../release.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.tag, "v0.1.0");
  assert.deepEqual(manifest.assets, [
    {
      platform: "mac-arm64",
      label: "Mac（Apple 芯片）",
      filename: "AI-XMP-Tagger-0.1.0-macOS-arm64.dmg",
      bytes: 115804442,
      sha256:
        "1f5cd0e3d157de1ca7df401e15d6a57d6b8566dc32ea24b5a5ba7d5678603051",
    },
    {
      platform: "mac-x64",
      label: "Mac（Intel）",
      filename: "AI-XMP-Tagger-0.1.0-macOS-x64.dmg",
      bytes: 121270087,
      sha256:
        "740dbd5fb8d9721c3d6ac660a1cb7697b84e8eef03b3349ac4814153a75041f4",
    },
    {
      platform: "windows-x64",
      label: "Windows（64 位）",
      filename: "AI-XMP-Tagger-0.1.0-Windows-x64-Setup.exe",
      bytes: 102880178,
      sha256:
        "daeff1576c42c03a1aed16857fa966b8c920cf534749a3acfa37ca67294d96a1",
    },
  ]);

  for (const asset of manifest.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.bytes > 100_000_000);
  }
});

test("release manifest validation rejects unsafe build metadata", async () => {
  const validManifest = JSON.parse(
    await readFile(new URL("../release.json", import.meta.url), "utf8"),
  );
  assert.equal(validateReleaseManifest(validManifest), validManifest);

  const invalidCases = [
    {
      name: "non-integer bytes",
      mutate(manifest) {
        manifest.assets[0].bytes = 1.5;
      },
      expected: /platform "mac-arm64" field "bytes".*positive integer/,
    },
    {
      name: "non-positive bytes",
      mutate(manifest) {
        manifest.assets[0].bytes = 0;
      },
      expected: /platform "mac-arm64" field "bytes".*positive integer/,
    },
    {
      name: "uppercase hash",
      mutate(manifest) {
        manifest.assets[0].sha256 = "A".repeat(64);
      },
      expected: /platform "mac-arm64" field "sha256".*lowercase 64-hex/,
    },
    {
      name: "empty filename",
      mutate(manifest) {
        manifest.assets[0].filename = "";
      },
      expected: /platform "mac-arm64" field "filename"/,
    },
    {
      name: "filename with path separators",
      mutate(manifest) {
        manifest.assets[0].filename = "../unsafe.dmg";
      },
      expected: /platform "mac-arm64" field "filename"/,
    },
    {
      name: "duplicate platform",
      mutate(manifest) {
        manifest.assets.push({ ...manifest.assets[0] });
      },
      expected: /platform "mac-arm64".*more than once/,
    },
    {
      name: "missing platform",
      mutate(manifest) {
        manifest.assets = manifest.assets.filter(
          ({ platform }) => platform !== "mac-x64",
        );
      },
      expected: /missing required platform "mac-x64"/,
    },
    {
      name: "malformed version",
      mutate(manifest) {
        const previousVersion = manifest.version;
        manifest.version = "0.1.0-..";
        manifest.tag = `v${manifest.version}`;
        for (const asset of manifest.assets) {
          asset.filename = asset.filename.replace(
            previousVersion,
            manifest.version,
          );
        }
      },
      expected: /field "version".*semantic version/,
    },
    {
      name: "incoherent tag",
      mutate(manifest) {
        manifest.tag = "v9.9.9";
      },
      expected: /field "tag".*equal "v0\.1\.0"/,
    },
  ];

  for (const { name, mutate, expected } of invalidCases) {
    const manifest = structuredClone(validManifest);
    mutate(manifest);
    assert.throws(() => validateReleaseManifest(manifest), expected, name);
  }
});

test("built page resolves every release token to v0.1.0 downloads", async () => {
  const html = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(html, /@@[A-Z0-9_]+@@/);
  const repository =
    process.env.GITHUB_REPOSITORY || "local/ai-xmp-tagger";
  const downloadRoot = `https://github.com/${repository}/releases/download/v0.1.0`;
  for (const filename of [
    "AI-XMP-Tagger-0.1.0-macOS-arm64.dmg",
    "AI-XMP-Tagger-0.1.0-macOS-x64.dmg",
    "AI-XMP-Tagger-0.1.0-Windows-x64-Setup.exe",
  ]) {
    assert.ok(html.includes(`${downloadRoot}/${filename}`));
  }
  assert.ok(html.includes("AI-XMP-Tagger-0.1.0-Windows-x64-Setup.exe"));
  assert.ok(html.includes("版本 v0.1.0、文件大小和 SHA-256"));
  for (const size of ["115.8 MB", "121.3 MB", "102.9 MB"]) {
    assert.ok(html.includes(size));
  }
  for (const { sha256 } of JSON.parse(
    await readFile(new URL("../release.json", import.meta.url), "utf8"),
  ).assets) {
    assert.ok(html.includes(sha256));
  }
});

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
    "checksums",
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

test("mode cards preserve their visible semantic numbers", async () => {
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

test("document head provides complete local-first search and share metadata", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(
    html,
    /<meta name="description" content="[^"]*本地批量[^"]*XMP[^"]*contains-synthetic-performer[^"]*">/,
  );
  assert.match(
    html,
    /<link rel="canonical" href="@@CANONICAL_URL@@">/,
  );
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(
    html,
    /<meta property="og:title" content="AI XMP Tagger · 本地批量 XMP 标签工具">/,
  );
  assert.match(
    html,
    /<meta property="og:description" content="[^"]*批量[^"]*(?:生成[^"]*检查|检查[^"]*生成)[^"]*(?:Mac[^"]*Windows|Windows[^"]*Mac)[^"]*">/,
  );
  assert.match(
    html,
    /<meta property="og:url" content="@@CANONICAL_URL@@">/,
  );
  assert.match(
    html,
    /<meta property="og:image" content="@@CANONICAL_URL@@images\/social-card\.png">/,
  );
  assert.match(
    html,
    /<meta property="og:image:width" content="1200">/,
  );
  assert.match(
    html,
    /<meta property="og:image:height" content="630">/,
  );
  assert.match(
    html,
    /<meta property="og:image:alt" content="[^"]*AI XMP Tagger[^"]*本地[^"]*XMP[^"]*">/,
  );
  assert.match(
    html,
    /<meta name="twitter:card" content="summary_large_image">/,
  );
});

test("authored and built web assets contain no analytics or tracking code", async () => {
  const authoredFiles = await listSourceFiles(
    projectDirectory,
    new Set([".git", "dist", "node_modules", "tests"]),
  );
  const builtFiles = await listSourceFiles(
    new URL("../dist/", import.meta.url),
  );
  const forbiddenTracking =
    /google-analytics|tagmanager|gtag\s*\(|dataLayer|plausible(?:\.io)?|clarity(?:\.ms)?|segment(?:\.com)?|analytics\.js|sendBeacon\s*\(|fetch\s*\([^)]*(?:analytics|telemetry|tracking|collect|events?|metrics?|insights?)|(?:analytics|telemetry|tracking|collect|events?|metrics?|insights?)[^;\n]*fetch\s*\(/i;

  for (const fileUrl of [...authoredFiles, ...builtFiles]) {
    const source = await readFile(fileUrl, "utf8");
    assert.doesNotMatch(
      source,
      forbiddenTracking,
      `unexpected tracking code in ${fileUrl.pathname}`,
    );
  }

  const indexHtml = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    indexHtml,
    /<(?:script|img|link)\b[^>]*(?:src|href)=["']https?:\/\//i,
  );
});

test("built page resolves canonical and social image metadata tokens", async () => {
  const html = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  const canonicalUrl =
    "https://local.github.io/ai-xmp-tagger/";

  assert.doesNotMatch(html, /@@[A-Z0-9_]+@@/);
  assert.ok(
    html.includes(`<link rel="canonical" href="${canonicalUrl}">`),
  );
  assert.ok(
    html.includes(`<meta property="og:url" content="${canonicalUrl}">`),
  );
  assert.ok(
    html.includes(
      `<meta property="og:image" content="${canonicalUrl}images/social-card.png">`,
    ),
  );
});

test("social card source is local-only and contains the approved copy", async () => {
  const html = await readFile(
    new URL("../social-card.html", import.meta.url),
    "utf8",
  );

  for (const copy of [
    "XMP",
    "AI XMP Tagger",
    "本地批量写入与检查 XMP 标签",
    "Mac / Windows · 本地离线处理",
  ]) {
    assert.ok(html.includes(copy));
  }
  assert.match(html, /src="\.\/public\/images\/app-home\.png"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("generated social card is a nonempty 1200 by 630 PNG", async () => {
  const imageUrl = new URL(
    "../public/images/social-card.png",
    import.meta.url,
  );
  const [image, imageStat] = await Promise.all([
    readFile(imageUrl),
    stat(imageUrl),
  ]);

  assert.ok(imageStat.size > 20_000);
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
});

test("social card lock proves source, renderer, contract, and output provenance", async () => {
  const lock = JSON.parse(
    await readFile(
      new URL("../social-card.lock.json", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(lock.contract, {
    version: 1,
    platform: "darwin",
    width: 1200,
    height: 630,
    deviceScaleFactor: 1,
    playwrightVersion: "1.61.1",
    font:
      '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  });

  for (const relativePath of [
    "social-card.html",
    "public/images/app-home.png",
    "scripts/capture-social-card.mjs",
    "public/images/social-card.png",
  ]) {
    assert.equal(
      lock.files[relativePath],
      sha256(await readFile(new URL(`../${relativePath}`, import.meta.url))),
      `${relativePath} must match social-card.lock.json`,
    );
  }
});

test("invalid temporary PNG cannot replace an existing valid social card", async () => {
  const { installValidatedPng } = await import(
    "../scripts/capture-social-card.mjs"
  );
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "social-card-atomic-test-"),
  );
  const outputPath = path.join(temporaryDirectory, "social-card.png");
  const invalidTempPath = path.join(
    temporaryDirectory,
    "invalid-social-card.tmp.png",
  );
  const knownValidPng = await readFile(
    new URL("../public/images/social-card.png", import.meta.url),
  );

  try {
    await writeFile(outputPath, knownValidPng);
    await writeFile(invalidTempPath, "not a png");

    await assert.rejects(
      installValidatedPng(invalidTempPath, outputPath),
      /PNG|social card/i,
    );
    assert.deepEqual(await readFile(outputPath), knownValidPng);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("non-macOS social card check verifies the lock without rendering", async () => {
  const { checkSocialCard } = await import(
    "../scripts/capture-social-card.mjs"
  );
  let rendered = false;
  const result = await checkSocialCard({
    platform: "linux",
    render: async () => {
      rendered = true;
      throw new Error("non-macOS checks must not render");
    },
    log() {},
  });

  assert.equal(result, "source-lock");
  assert.equal(rendered, false);
});

test("favicon provides the standalone XMP mark", async () => {
  const favicon = await readFile(
    new URL("../public/favicon.svg", import.meta.url),
    "utf8",
  );

  assert.match(favicon, /viewBox="0 0 64 64"/);
  assert.match(favicon, />XMP</);
});

test("README explains the public beta repository, privacy, preview, and provenance contracts", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );

  for (const requiredCopy of [
    "公开测试版（public beta）的网站与下载仓库",
    "GitHub Pages",
    "GitHub Releases",
    "桌面应用源码不在本仓库",
    "不会接收图片、路径或用户数据",
    "npm run dev",
    "npm test",
    "非 Amazon 官方产品",
    "经过清理的中性测试素材",
    "Preview",
    "ExifTool",
  ]) {
    assert.ok(
      readme.includes(requiredCopy),
      `README must include: ${requiredCopy}`,
    );
  }
  assert.match(readme, /(?:npm ci|npm install)/);
  assert.match(
    readme,
    /Preview[\s\S]*ExifTool[\s\S]*(?:如实|明确)[\s\S]*(?:说明|标注)/,
  );

  try {
    await stat(new URL("../LICENSE", import.meta.url));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    assert.doesNotMatch(
      readme,
      /\b(?:MIT|Apache|GPL|BSD)\b|开源许可|采用[^。\n]*许可证/,
    );
  }
});

test("release guide covers checksums, unsigned installers, safe OS guidance, and Windows limits", async () => {
  const releaseGuide = await readFile(
    new URL("../RELEASE.md", import.meta.url),
    "utf8",
  );

  for (const requiredCopy of [
    "SHA256SUMS.txt",
    "安装包暂未签名",
    "Apple Gatekeeper",
    "Windows SmartScreen",
    "Windows 包只完成静态架构和资源验证",
    "尚未在真实 Windows",
  ]) {
    assert.ok(
      releaseGuide.includes(requiredCopy),
      `RELEASE.md must include: ${requiredCopy}`,
    );
  }
  assert.match(
    releaseGuide,
    /不要[\s\S]*(?:关闭|停用)[\s\S]*Gatekeeper[\s\S]*SmartScreen/,
  );
});

test("release guide preserves the required private-to-public release order", async () => {
  const releaseGuide = await readFile(
    new URL("../RELEASE.md", import.meta.url),
    "utf8",
  );
  const positions = [
    /私有仓库[\s\S]{0,120}(?:测试|npm test)[\s\S]{0,120}(?:类型检查|typecheck)[\s\S]{0,160}(?:安装包|打包)[\s\S]{0,120}(?:Mac|macOS)[\s\S]{0,80}(?:冒烟|smoke)/i,
    /核对[\s\S]{0,120}文件名[\s\S]{0,120}(?:字节数|bytes)[\s\S]{0,120}(?:SHA-256|哈希)/i,
    /预发布[\s\S]{0,160}(?:3 个|三个)[\s\S]{0,120}安装包[\s\S]{0,120}SHA256SUMS\.txt/i,
    /发布 GitHub Release[\s\S]{0,160}(?:GitHub Pages|Pages)/i,
    /检查[\s\S]{0,120}(?:Release 资产|发布资产|assets)[\s\S]{0,160}(?:私有源码|桌面应用源码)/i,
  ].map((pattern) => {
    const match = pattern.exec(releaseGuide);
    assert.ok(match, `RELEASE.md must match ordered release step: ${pattern}`);
    return match.index;
  });

  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("Pages workflow is manual-only and uses the current official action majors", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );
  const triggerBlock = workflow.match(/^on:\s*\n([\s\S]*?)^permissions:/m);

  assert.ok(triggerBlock, "workflow must define triggers before permissions");
  assert.equal(triggerBlock[1].trim(), "workflow_dispatch:");
  assert.doesNotMatch(triggerBlock[1], /^\s*push:/m);
  assert.match(workflow, /^name: Test and deploy GitHub Pages$/m);

  for (const action of [
    "actions/checkout@v7",
    "actions/setup-node@v7",
    "actions/configure-pages@v5",
    "actions/upload-pages-artifact@v4",
    "actions/deploy-pages@v4",
  ]) {
    assert.equal(
      workflow.match(new RegExp(action.replace("/", "\\/"), "g"))?.length,
      1,
      `workflow must use ${action} exactly once`,
    );
  }
});

test("Pages workflow builds, verifies, uploads dist, and deploys with least privilege", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /^permissions:\n  contents: read\n  pages: write\n  id-token: write$/m,
  );
  assert.match(
    workflow,
    /^concurrency:\n  group: pages\n  cancel-in-progress: false$/m,
  );
  assert.match(workflow, /^\s{2}build:\n\s{4}runs-on: ubuntu-latest$/m);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /cache: npm/);
  assert.match(workflow, /run: npm ci/);
  assert.match(
    workflow,
    /run: npx playwright install --with-deps chromium/,
  );
  assert.match(
    workflow,
    /run: npm test\n\s+env:\n\s+GITHUB_REPOSITORY: \$\{\{ github\.repository \}\}/,
  );
  assert.match(
    workflow,
    /uses: actions\/upload-pages-artifact@v4\n\s+with:\n\s+path: dist/,
  );
  assert.match(
    workflow,
    /^\s{2}deploy:\n\s{4}needs: build\n\s{4}runs-on: ubuntu-latest$/m,
  );
  assert.match(
    workflow,
    /environment:\n\s+name: github-pages\n\s+url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/,
  );
  assert.match(
    workflow,
    /id: deployment\n\s+uses: actions\/deploy-pages@v4/,
  );
});
