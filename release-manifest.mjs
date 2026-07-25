const requiredAssets = [
  {
    platform: "mac-arm64",
    filename(version) {
      return `AI-XMP-Tagger-${version}-macOS-arm64.dmg`;
    },
  },
  {
    platform: "mac-x64",
    filename(version) {
      return `AI-XMP-Tagger-${version}-macOS-x64.dmg`;
    },
  },
  {
    platform: "windows-x64",
    filename(version) {
      return `AI-XMP-Tagger-${version}-Windows-x64-Setup.exe`;
    },
  },
];

const requiredPlatforms = new Set(
  requiredAssets.map(({ platform }) => platform),
);

export function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("release.json must contain a JSON object");
  }

  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)
  ) {
    throw new Error(
      'release.json field "version" must be a nonempty semantic version',
    );
  }

  const expectedTag = `v${manifest.version}`;
  if (manifest.tag !== expectedTag) {
    throw new Error(
      `release.json field "tag" must equal "${expectedTag}" for version "${manifest.version}"`,
    );
  }

  if (!Array.isArray(manifest.assets)) {
    throw new Error('release.json field "assets" must be an array');
  }

  const assetsByPlatform = new Map();
  for (const asset of manifest.assets) {
    const platform =
      asset && typeof asset === "object" ? asset.platform : undefined;

    if (typeof platform !== "string" || platform.length === 0) {
      throw new Error(
        'release.json asset field "platform" must be a nonempty string',
      );
    }
    if (!requiredPlatforms.has(platform)) {
      throw new Error(`release.json platform "${platform}" is not supported`);
    }
    if (assetsByPlatform.has(platform)) {
      throw new Error(
        `release.json platform "${platform}" appears more than once`,
      );
    }

    assetsByPlatform.set(platform, asset);
  }

  for (const definition of requiredAssets) {
    const asset = assetsByPlatform.get(definition.platform);
    if (!asset) {
      throw new Error(
        `release.json is missing required platform "${definition.platform}"`,
      );
    }

    const expectedFilename = definition.filename(manifest.version);
    if (
      typeof asset.filename !== "string" ||
      asset.filename.length === 0 ||
      asset.filename.includes("/") ||
      asset.filename.includes("\\") ||
      asset.filename !== expectedFilename
    ) {
      throw new Error(
        `release.json platform "${definition.platform}" field "filename" must equal "${expectedFilename}" and contain no path separators`,
      );
    }

    if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) {
      throw new Error(
        `release.json platform "${definition.platform}" field "bytes" must be a positive integer`,
      );
    }

    if (
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error(
        `release.json platform "${definition.platform}" field "sha256" must be a lowercase 64-hex SHA-256`,
      );
    }
  }

  return manifest;
}
