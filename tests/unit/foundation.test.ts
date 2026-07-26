// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function readProjectFile(relativePath: string) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

describe("web app foundation", () => {
  it("uses a typed Preact entry and keeps processing dependencies local", async () => {
    const pkg = JSON.parse(await readProjectFile("package.json"));
    expect(pkg.dependencies).toMatchObject({
      preact: "10.29.7",
      "@xmldom/xmldom": "0.9.10",
      "@jsquash/jpeg": "1.6.0",
      "client-zip": "2.5.0",
    });
    expect(await readProjectFile("src/main.tsx")).toContain("render(<App />");
    expect(await readProjectFile("vite.config.ts")).toContain(
      'exclude: ["@jsquash/jpeg"]',
    );
  });

  it("scopes release helper typings without declaring every mjs module", async () => {
    const declaration = await readProjectFile("release-build.d.mts");
    expect(declaration).not.toContain('declare module "*.mjs"');
  });
});
