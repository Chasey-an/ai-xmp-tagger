import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(path, "utf8");
}

describe("browser-local product guidance", () => {
  it("presents direct browser processing as the primary product", async () => {
    const [app, html, readme] = await Promise.all([
      source("src/app/App.tsx"),
      source("index.html"),
      source("README.md"),
    ]);
    const productCopy = `${app}\n${html}\n${readme}`;

    expect(app).toContain(
      "<h1>在浏览器批量添加 AI 生成人物 XMP 标签</h1>",
    );
    expect(productCopy).toMatch(/浏览器.*(?:直接|本地).*(?:处理|写入|检查)/su);
    expect(productCopy).toContain("图片只在当前浏览器");
    expect(productCopy).toContain("不会上传");
    expect(productCopy).toMatch(
      /Netlify.*页面请求.*静态资源请求.*不会收到.*图片.*文件名.*处理结果/su,
    );
    expect(productCopy).toContain("不接入统计");
    expect(productCopy).toContain("独立");
    expect(productCopy).toContain("非 Amazon 官方产品");
  });

  it("documents all three modes with the exact format matrix", async () => {
    const guidance = `${await source("src/app/HelpSections.tsx")}\n${await source("README.md")}`;

    expect(guidance).toMatch(/转为高清 JPG/u);
    expect(guidance).toMatch(/JPG 直接写入/u);
    expect(guidance).toMatch(/PNG、BMP、静态 WebP 转为高质量 JPG/u);
    expect(guidance).toMatch(/动态 WebP.*(?:拒绝|不支持)/u);
    expect(guidance).toMatch(/保持原格式/u);
    expect(guidance).toMatch(/JPG、PNG、静态或动态 WebP.*保持原格式/u);
    expect(guidance).toMatch(/BMP 不支持/u);
    expect(guidance).toMatch(/只检查/u);
    expect(guidance).toMatch(/不改图片.*JPG、PNG.*WebP/su);
  });

  it("states the exact browser safety limits and conversion privacy boundary", async () => {
    const guidance = `${await source("src/app/HelpSections.tsx")}\n${await source("README.md")}`;

    for (const text of ["300", "50 MiB", "500 MiB", "40 MP"]) {
      expect(guidance).toContain(text);
    }
    expect(guidance).toMatch(/转为.*JPG.*(?:移除|不保留).*EXIF.*GPS/su);
    expect(guidance).toMatch(/仅保留.*dc:subject|只保留.*dc:subject/su);
  });

  it("documents modern browser support and keeps desktop downloads as fallback only", async () => {
    const [readme, release, help] = await Promise.all([
      source("README.md"),
      source("RELEASE.md"),
      source("src/app/HelpSections.tsx"),
    ]);
    const guidance = `${readme}\n${release}\n${help}`;

    expect(guidance).toMatch(/最新版.*Chrome.*Edge.*Safari/su);
    expect(guidance).toMatch(/HEIC.*TIFF.*大批量/su);
    expect(guidance).toMatch(/桌面.*备用|备用.*桌面/su);
    expect(readme).not.toMatch(/网站与下载仓库|GitHub Pages/u);
  });

  it("gives independent ExifTool verification commands for macOS and Windows", async () => {
    const guidance = `${await source("README.md")}\n${await source("RELEASE.md")}`;

    expect(guidance).toContain(
      "exiftool -G1 -XMP-dc:Subject processed.jpg",
    );
    expect(guidance).toContain(
      'exiftool.exe -G1 -XMP-dc:Subject "processed.jpg"',
    );
    expect(guidance).toContain("contains-synthetic-performer");
  });
});

describe("Netlify static-hosting contract", () => {
  it("uses the exact build, Node, CSP, privacy, and cache settings", async () => {
    const config = await source("netlify.toml");

    expect(config).toContain('command = "npm run build"');
    expect(config).toContain('publish = "dist"');
    expect(config).toContain('NODE_VERSION = "24"');
    expect(config).toContain('X-Content-Type-Options = "nosniff"');
    expect(config).toContain('Referrer-Policy = "no-referrer"');
    expect(config).toContain(
      'Permissions-Policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"',
    );
    expect(config).toContain(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; media-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
    );
    const connectDirective =
      config.match(/connect-src\s+([^;"]+)/u)?.[1]?.trim();
    expect(connectDirective).toBe("'self'");
    expect(connectDirective).not.toMatch(/https?:|data:|blob:/u);
    expect(config).toContain(
      'Cache-Control = "public, max-age=31536000, immutable"',
    );
    expect(config).toContain(
      'Cache-Control = "public, max-age=0, must-revalidate"',
    );
  });

  it("has no runtime network or Pages deployment machinery", async () => {
    const [html, entry, app, css, packageJson, workflow, readme, release] =
      await Promise.all([
      source("index.html"),
      source("src/main.tsx"),
      source("src/app/App.tsx"),
      source("src/styles.css"),
      source("package.json"),
      source(".github/workflows/test.yml"),
      source("README.md"),
      source("RELEASE.md"),
    ]);
    const runtimeSources = `${html}\n${entry}\n${app}\n${css}\n${packageJson}`;

    expect(runtimeSources).not.toMatch(
      /google-analytics|googletagmanager|plausible|fonts\.googleapis|fonts\.gstatic|<script[^>]+https?:\/\/|XMLHttpRequest|fetch\s*\(/iu,
    );
    expect(`${readme}\n${release}`).not.toMatch(/GitHub Pages|github\.io/iu);
    expect(packageJson).not.toMatch(
      /test:content|test:release|test:ci-repository/u,
    );
    expect(workflow).not.toMatch(
      /configure-pages|deploy-pages|upload-pages-artifact|pages: write|id-token: write/u,
    );
  });
});
