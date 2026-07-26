import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("secondary desktop fallback release contract", () => {
  it("retains the exact published desktop asset checksums", async () => {
    const manifest = JSON.parse(
      await readFile("release.json", "utf8"),
    ) as {
      version: string;
      tag: string;
      assets: Array<{
        platform: string;
        filename: string;
        bytes: number;
        sha256: string;
      }>;
    };

    expect(manifest.version).toBe("0.1.0");
    expect(manifest.tag).toBe("v0.1.0");
    expect(manifest.assets).toEqual([
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
      expect(asset.filename).toContain(manifest.version);
      expect(asset.bytes).toBeGreaterThan(100_000_000);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("describes desktop packages only as a fallback outside the web-app limits", async () => {
    const release = await readFile("RELEASE.md", "utf8");

    expect(release).toMatch(/浏览器版是主要使用方式/u);
    expect(release).toMatch(/HEIC.*TIFF.*大批量/su);
    expect(release).toMatch(/桌面.*备用|备用.*桌面/su);
    expect(release).not.toMatch(/GitHub Pages|Test and deploy GitHub Pages/u);
  });
});
