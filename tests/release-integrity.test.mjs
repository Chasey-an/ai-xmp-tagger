import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import {
  createReleaseTokens,
  injectReleaseTokens,
  parseRepository,
} from "../release-build.mjs";
import {
  parseDistDirectoryArgument,
  runCli,
  sha256File,
  verifyAsset,
  verifyReleaseAssets,
} from "../scripts/assert-release-assets.mjs";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ai-xmp-release-integrity-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function tinyManifest() {
  const definitions = [
    [
      "mac-arm64",
      "Mac（Apple 芯片）",
      "AI-XMP-Tagger-1.2.3-macOS-arm64.dmg",
      "arm",
    ],
    [
      "mac-x64",
      "Mac（Intel）",
      "AI-XMP-Tagger-1.2.3-macOS-x64.dmg",
      "intel",
    ],
    [
      "windows-x64",
      "Windows（64 位）",
      "AI-XMP-Tagger-1.2.3-Windows-x64-Setup.exe",
      "windows",
    ],
  ];

  return {
    version: "1.2.3",
    tag: "v1.2.3",
    assets: definitions.map(([platform, label, filename, content]) => ({
      platform,
      label,
      filename,
      bytes: Buffer.byteLength(content),
      sha256: hash(content),
      content,
    })),
  };
}

test("streaming release verifier accepts exact assets and reports each file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifest = tinyManifest();
    for (const asset of manifest.assets) {
      await writeFile(path.join(directory, asset.filename), asset.content);
      delete asset.content;
    }

    const messages = [];
    await verifyReleaseAssets(directory, manifest, {
      log(message) {
        messages.push(message);
      },
    });

    assert.deepEqual(
      messages,
      manifest.assets.map(({ filename }) => `verified ${filename}`),
    );
    assert.equal(
      await sha256File(path.join(directory, manifest.assets[0].filename)),
      manifest.assets[0].sha256,
    );
  });
});

test("release verifier rejects byte and SHA-256 mismatches", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filename = "fixture.bin";
    const content = "abc";
    await writeFile(path.join(directory, filename), content);

    await assert.rejects(
      verifyAsset(directory, {
        filename,
        bytes: 4,
        sha256: hash(content),
      }),
      /Byte count mismatch for fixture\.bin: expected 4, got 3/,
    );
    await assert.rejects(
      verifyAsset(directory, {
        filename,
        bytes: 3,
        sha256: "0".repeat(64),
      }),
      /SHA-256 mismatch for fixture\.bin: expected 0{64}, got [a-f0-9]{64}/,
    );
  });
});

test("release verifier rejects missing paths and directories", async () => {
  await withTemporaryDirectory(async (directory) => {
    const missing = {
      filename: "missing.bin",
      bytes: 1,
      sha256: "0".repeat(64),
    };
    await assert.rejects(
      verifyAsset(directory, missing),
      new RegExp(`Missing release asset: .*${missing.filename}`),
    );

    const directoryAsset = { ...missing, filename: "not-a-file.bin" };
    await mkdir(path.join(directory, directoryAsset.filename));
    await assert.rejects(
      verifyAsset(directory, directoryAsset),
      new RegExp(`Release asset is not a file: .*${directoryAsset.filename}`),
    );
  });
});

test("release verifier CLI requires one absolute directory and propagates failures", async () => {
  const usage =
    /Usage: node scripts\/assert-release-assets\.mjs \/absolute\/path\/to\/dist/;

  assert.throws(() => parseDistDirectoryArgument([]), usage);
  assert.throws(() => parseDistDirectoryArgument(["relative/dist"]), usage);
  assert.throws(
    () => parseDistDirectoryArgument(["/first", "/second"]),
    usage,
  );

  await withTemporaryDirectory(async (emptyDirectory) => {
    await assert.rejects(
      runCli([emptyDirectory], { log() {} }),
      /Missing release asset: .*AI-XMP-Tagger-0\.1\.0-macOS-arm64\.dmg/,
    );
  });
});

test("release build helpers create canonical URLs, decimal MB, and strict tokens", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../release.json", import.meta.url), "utf8"),
  );
  const tokens = createReleaseTokens(manifest, "example-owner/example-repo");

  assert.equal(tokens.MAC_ARM64_SIZE, "115.8 MB");
  assert.equal(tokens.MAC_X64_SIZE, "121.3 MB");
  assert.equal(tokens.WINDOWS_X64_SIZE, "102.9 MB");
  assert.equal(
    tokens.CANONICAL_URL,
    "https://example-owner.github.io/example-repo/",
  );
  assert.equal(
    tokens.RELEASES_URL,
    "https://github.com/example-owner/example-repo/releases",
  );
  assert.deepEqual(parseRepository("local/ai-xmp-tagger"), {
    owner: "local",
    name: "ai-xmp-tagger",
  });

  for (const malformed of [
    "missing-slash",
    "/missing-owner",
    "owner/",
    "owner/repository/extra",
    "owner-/repository",
  ]) {
    assert.throws(
      () => parseRepository(malformed),
      new RegExp(`Invalid GITHUB_REPOSITORY "${malformed}"`),
    );
  }

  assert.equal(
    injectReleaseTokens("v@@VERSION@@", tokens),
    "v0.1.0",
  );
  assert.throws(
    () => injectReleaseTokens("@@UNKNOWN_TOKEN@@", tokens),
    /No build-time value is defined for HTML token @@UNKNOWN_TOKEN@@/,
  );
});

test("development server resolves exact URLs for fallback and explicit repositories", async () => {
  const previousRepository = process.env.GITHUB_REPOSITORY;

  try {
    for (const testCase of [
      {
        repository: undefined,
        expectedRepository: "local/ai-xmp-tagger",
        expectedCanonicalUrl: "https://local.github.io/ai-xmp-tagger/",
      },
      {
        repository: "example-owner/ai-xmp-tagger",
        expectedRepository: "example-owner/ai-xmp-tagger",
        expectedCanonicalUrl:
          "https://example-owner.github.io/ai-xmp-tagger/",
      },
    ]) {
      if (testCase.repository === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = testCase.repository;
      }

      let server;
      try {
        server = await createServer({
          configFile: path.join(projectDirectory, "vite.config.js"),
          root: projectDirectory,
          logLevel: "silent",
          server: {
            host: "127.0.0.1",
            port: 0,
          },
        });
        await server.listen();
        const address = server.httpServer.address();
        assert.ok(address && typeof address === "object");

        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        assert.equal(response.status, 200);
        const html = await response.text();
        const windowsUrl =
          `https://github.com/${testCase.expectedRepository}/releases/download/` +
          "v0.1.0/AI-XMP-Tagger-0.1.0-Windows-x64-Setup.exe";

        assert.doesNotMatch(html, /@@[A-Z0-9_]+@@/);
        assert.ok(
          html.includes(
            `<link rel="canonical" href="${testCase.expectedCanonicalUrl}">`,
          ),
        );
        assert.ok(html.includes(`href="${windowsUrl}"`));
      } finally {
        await server?.close();
      }
    }
  } finally {
    if (previousRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = previousRepository;
    }
  }
});

test("portable CI repository launcher uses current executables and guards recursion", async () => {
  const {
    CI_REPOSITORY_TEST_FLAG,
    createCiRepositoryTestInvocation,
    runCiRepositoryTests,
  } = await import("../scripts/test-ci-repository.mjs");
  const baseEnvironment = { KEEP_ME: "yes" };
  const invocation = createCiRepositoryTestInvocation({
    execPath: "/current/runtime/node",
    npmExecPath: "/current/npm/npm-cli.js",
    env: baseEnvironment,
  });

  assert.equal(invocation.command, "/current/runtime/node");
  assert.deepEqual(invocation.args, ["/current/npm/npm-cli.js", "test"]);
  assert.equal(invocation.options.stdio, "inherit");
  assert.deepEqual(invocation.options.env, {
    KEEP_ME: "yes",
    CI: "true",
    GITHUB_REPOSITORY: "example-owner/ai-xmp-tagger",
    [CI_REPOSITORY_TEST_FLAG]: "1",
  });
  assert.deepEqual(baseEnvironment, { KEEP_ME: "yes" });

  const calls = [];
  const child = new EventEmitter();
  const runPromise = runCiRepositoryTests({
    execPath: "/current/runtime/node",
    npmExecPath: "/current/npm/npm-cli.js",
    env: baseEnvironment,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(await runPromise, 0);
  assert.deepEqual(calls, [invocation]);

  assert.throws(
    () =>
      createCiRepositoryTestInvocation({
        execPath: "/current/runtime/node",
        npmExecPath: "/current/npm/npm-cli.js",
        env: { [CI_REPOSITORY_TEST_FLAG]: "1" },
      }),
    /recursion/i,
  );
  assert.throws(
    () =>
      createCiRepositoryTestInvocation({
        execPath: "/current/runtime/node",
        env: {},
      }),
    /npm executable/i,
  );
});
