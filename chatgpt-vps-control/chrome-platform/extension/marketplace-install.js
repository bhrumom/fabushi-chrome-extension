const VERSION_PART_PATTERN = /[.+-]/;

export const MARKETPLACE_INSTALL_PROTOCOL = "fabushi.marketplace.install.v1";

export function compareMarketplaceVersions(left, right) {
  const a = String(left || "").trim().replace(/^v/i, "");
  const b = String(right || "").trim().replace(/^v/i, "");
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const tokenize = (value) => value.split(VERSION_PART_PATTERN).flatMap((part) => {
    const numbers = part.match(/\d+/g);
    return numbers ? numbers.map((number) => Number(number)) : [0];
  });
  const aParts = tokenize(a);
  const bParts = tokenize(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = aParts[index] || 0;
    const bPart = bParts[index] || 0;
    if (aPart !== bPart) return aPart > bPart ? 1 : -1;
  }
  const aPrerelease = /-/.test(a);
  const bPrerelease = /-/.test(b);
  if (aPrerelease !== bPrerelease) return aPrerelease ? -1 : 1;
  return 0;
}

export function marketplaceItemId(item) {
  return String(item?.pluginId || item?.id || item?.name || "").trim();
}

export function marketplaceItemVersion(item) {
  return String(item?.latestVersion || item?.version || item?.releaseManifest?.version || "").trim();
}

export function marketplaceItemSurfaces(item) {
  return [
    ...(Array.isArray(item?.surfaces) ? item.surfaces : []),
    ...(Array.isArray(item?.source?.surfaces) ? item.source.surfaces : []),
    ...(Array.isArray(item?.releaseManifest?.surfaces) ? item.releaseManifest.surfaces : []),
  ];
}

export function marketplaceUserscriptSurface(item) {
  return marketplaceItemSurfaces(item).find((surface) => surface?.kind === "userscript"
    || surface?.id === "userscript"
    || /\.user\.js$/i.test(String(surface?.entry || ""))) || null;
}

export function marketplaceReleaseManifest(item) {
  const release = item?.releaseManifest;
  return release?.releaseManifest && typeof release.releaseManifest === "object"
    ? release.releaseManifest
    : release;
}

export function marketplaceInstallContract(item) {
  const release = marketplaceReleaseManifest(item);
  return item?.install && typeof item.install === "object"
    ? item.install
    : release?.install && typeof release.install === "object"
      ? release.install
      : null;
}

function publicGithubRepository(value) {
  try {
    const url = new URL(String(value || "").trim());
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.protocol !== "https:"
      || url.hostname.toLowerCase() !== "github.com"
      || parts.length !== 2
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash) return null;
    return { url, parts };
  } catch {
    return null;
  }
}

function isGithubArtifactUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:"
      && ["github.com", "raw.githubusercontent.com"].includes(url.hostname.toLowerCase())
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function githubArtifactMatchesSource(contract, artifact) {
  const source = contract?.source;
  const repository = publicGithubRepository(source?.repository);
  const sourceRef = String(source?.sourceRef || "").trim();
  const artifactSource = artifact?.source;
  if (!repository || !/^[a-f0-9]{40}$/i.test(sourceRef)
    || artifactSource?.type !== "https" || !isGithubArtifactUrl(artifactSource.url)) return false;
  try {
    const url = new URL(String(artifactSource.url).trim());
    if (url.hostname.toLowerCase() === "raw.githubusercontent.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length >= 4
        && parts[0] === repository.parts[0]
        && parts[1] === repository.parts[1]
        && parts[2] === sourceRef;
    }
    return true;
  } catch {
    return false;
  }
}

export function marketplacePackageArtifact(item) {
  const release = marketplaceReleaseManifest(item);
  return Array.isArray(release?.artifacts)
    ? release.artifacts.find((artifact) => !["user-js", "userscript"].includes(String(artifact?.format || "").toLowerCase())) || null
    : null;
}

export function marketplaceUserscriptArtifact(item) {
  const contract = marketplaceInstallContract(item);
  const release = marketplaceReleaseManifest(item);
  const artifacts = [
    ...(Array.isArray(contract?.artifacts) ? contract.artifacts : []),
    ...(Array.isArray(release?.artifacts) ? release.artifacts : []),
  ];
  return artifacts.find((artifact) => artifact?.runtime === "userscript"
    || ["user-js", "userscript"].includes(String(artifact?.format || "").toLowerCase())) || null;
}

export function marketplaceItemKind(item) {
  if (marketplaceUserscriptSurface(item)) return "userscript";
  if (marketplacePackageArtifact(item) || item?.installMode === "package") return "package";
  if (item?.installMode === "metadata") return "metadata";
  return "unknown";
}

export function marketplaceItemInstallable(item) {
  const kind = marketplaceItemKind(item);
  if (!marketplaceItemId(item) || kind === "unknown") return false;
  const install = marketplaceInstallContract(item);
  const source = install?.source;
  const itemId = marketplaceItemId(item);
  const itemVersion = marketplaceItemVersion(item);
  const sharedContract = install?.protocol === MARKETPLACE_INSTALL_PROTOCOL
    && install.strategy === "github-immutable"
    && install.pluginId === itemId
    && install.version === itemVersion
    && source?.marketplaceHostsPackage !== true
    && typeof source?.repository === "string"
    && typeof source?.sourceRef === "string"
    && source.sourceRef.trim().length > 0;
  // A bundled script is a signed extension compatibility path. Any script
  // advertised by the Marketplace itself must carry the same GitHub contract
  // as a package, so a catalog entry cannot turn an arbitrary URL into code.
  return kind === "userscript"
    ? Boolean(sharedContract
      && marketplaceUserscriptArtifact(item)
      && githubArtifactMatchesSource(install, marketplaceUserscriptArtifact(item)))
    : kind === "package"
      ? Boolean(sharedContract
        && Array.isArray(install?.artifacts)
        && install.artifacts.length > 0)
      : Boolean(sharedContract);
}

export function marketplaceInstalledVersion(item, installed, userscript) {
  if (userscript) {
    return String(item?.bundledFallback
      ? userscript.version
      : (userscript.sourcePluginVersion || userscript.version || "")).trim();
  }
  return String(installed?.version || "").trim();
}

export function marketplaceInstalledDigest(installed, userscript) {
  return String(
    installed?.artifactSha256
      || installed?.sha256
      || userscript?.sourceArtifactSha256
      || userscript?.artifactSha256
      || "",
  ).trim().toLowerCase();
}

export function marketplaceExpectedDigest(item) {
  const artifact = marketplacePackageArtifact(item) || marketplaceUserscriptArtifact(item);
  return String(artifact?.sha256 || artifact?.artifactSha256 || "").trim().toLowerCase();
}

export function marketplaceUpdateAvailable(item, installed, userscript) {
  if (!installed && !userscript) return false;
  const available = marketplaceItemVersion(item);
  const current = marketplaceInstalledVersion(item, installed, userscript);
  if (available && (!current || compareMarketplaceVersions(available, current) > 0)) return true;
  const expectedDigest = marketplaceExpectedDigest(item);
  const installedDigest = marketplaceInstalledDigest(installed, userscript);
  return Boolean(expectedDigest && installedDigest && expectedDigest !== installedDigest);
}

export function marketplaceInstallAction(item, installed, userscript) {
  if (!installed && !userscript) return "install";
  const available = marketplaceItemVersion(item);
  const current = marketplaceInstalledVersion(item, installed, userscript);
  if (available && current && compareMarketplaceVersions(current, available) > 0) {
    // Userscript versions are authoritative in their own metadata/update URL.
    // A stale Marketplace projection must not turn a successfully updated
    // script into a fake downgrade/error state.
    if (marketplaceItemKind(item) === "userscript") return "current";
    return "blocked";
  }
  if (!current || (available && compareMarketplaceVersions(current, available) < 0)) return "update";
  const expectedDigest = marketplaceExpectedDigest(item);
  const installedDigest = marketplaceInstalledDigest(installed, userscript);
  if (expectedDigest && installedDigest && expectedDigest !== installedDigest) return "reinstall";
  return "current";
}
