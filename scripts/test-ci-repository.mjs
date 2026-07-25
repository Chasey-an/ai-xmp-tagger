import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CI_REPOSITORY_TEST_FLAG = "AI_XMP_CI_REPOSITORY_TEST";

export function createCiRepositoryTestInvocation(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const npmExecPath = options.npmExecPath ?? env.npm_execpath;

  if (env[CI_REPOSITORY_TEST_FLAG] === "1") {
    throw new Error("Refusing CI repository test recursion");
  }
  if (!npmExecPath) {
    throw new Error(
      "Unable to find the current npm executable; run this through npm",
    );
  }

  return {
    command: execPath,
    args: [npmExecPath, "test"],
    options: {
      stdio: "inherit",
      env: {
        ...env,
        CI: "true",
        GITHUB_REPOSITORY: "example-owner/ai-xmp-tagger",
        [CI_REPOSITORY_TEST_FLAG]: "1",
      },
    },
  };
}

export function runCiRepositoryTests({
  spawnImpl = spawn,
  ...invocationOptions
} = {}) {
  const invocation = createCiRepositoryTestInvocation(invocationOptions);
  const child = spawnImpl(
    invocation.command,
    invocation.args,
    invocation.options,
  );

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    process.exitCode = await runCiRepositoryTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
