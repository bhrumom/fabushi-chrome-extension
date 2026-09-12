import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LEGACY_NATIVE_HOST_NAME, NATIVE_HOST_NAME, browserExtensionPaths } from "./browser-extension-paths.js";
import { installLocalRuntime } from "./local-install.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHROME_PLATFORM_NATIVE_HOST_NAME = "com.fabushi.chrome_platform";
export const PUBLISHED_EXTENSION_ID_ENV = "FABUSHI_CHROME_EXTENSION_ID";
export const PUBLISHED_EXTENSION_PUBLIC_KEY_ENV = "FABUSHI_CHROME_EXTENSION_PUBLIC_KEY";

function extensionIdFromPublicKey(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

function shellQuote(value) {
  const escaped = String(value).split("'").join(["'", '"', "'", '"', "'"].join(""));
  return `'${escaped}'`;
}

function validExtensionId(value) {
  return /^[a-p]{32}$/.test(String(value || "").trim());
}

function configuredPublishedIdentity(env = process.env) {
  const extensionId = String(env[PUBLISHED_EXTENSION_ID_ENV] || "").trim();
  const publicKey = String(env[PUBLISHED_EXTENSION_PUBLIC_KEY_ENV] || "").trim();
  if (extensionId && !validExtensionId(extensionId)) {
    throw new Error(`${PUBLISHED_EXTENSION_ID_ENV} must be a 32-character Chrome extension ID.`);
  }
  if (publicKey && !/^[A-Za-z0-9+/=_-]+$/.test(publicKey)) {
    throw new Error(`${PUBLISHED_EXTENSION_PUBLIC_KEY_ENV} must be a base64-encoded Chrome extension public key.`);
  }
  return { extensionId, publicKey };
}

export function nativeManifestDestinations(currentPlatform = platform()) {
  const home = homedir();
  if (process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) {
    return [{ browser: "custom", directory: resolve(process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) }];
  }
  if (currentPlatform === "darwin") return [
    { browser: "chrome", directory: join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts") },
    { browser: "chromium", directory: join(home, "Library/Application Support/Chromium/NativeMessagingHosts") },
    { browser: "edge", directory: join(home, "Library/Application Support/Microsoft Edge/NativeMessagingHosts") },
  ];
  if (currentPlatform === "linux") return [
    { browser: "chrome", directory: join(home, ".config/google-chrome/NativeMessagingHosts") },
    { browser: "chromium", directory: join(home, ".config/chromium/NativeMessagingHosts") },
    { browser: "edge", directory: join(home, ".config/microsoft-edge/NativeMessagingHosts") },
  ];
  return [{ browser: "windows", directory: browserExtensionPaths().home }];
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function ensureSecret(path) {
  try {
    const current = (await readFile(path, "utf8")).trim();
    if (current.length >= 32) return current;
  } catch {}
  const secret = randomBytes(32).toString("base64url");
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

async function installWindowsRegistry(manifests) {
  for (const manifest of manifests) {
    for (const product of ["Google\\Chrome", "Microsoft\\Edge"]) {
      const key = `HKCU\\Software\\${product}\\NativeMessagingHosts\\${manifest.name}`;
      await execFileAsync("reg.exe", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifest.path, "/f"]);
    }
  }
}

async function writeLauncher(currentPlatform, launcherPath, hostScript, home) {
  if (currentPlatform === "win32") {
    await writeFile(launcherPath, `@echo off\r\nset "COMPUTER_BROWSER_EXTENSION_HOME=${home}"\r\n"${process.execPath}" "${hostScript}"\r\n`, { mode: 0o700 });
    return;
  }
  await writeFile(launcherPath, `#!/bin/sh\nexport COMPUTER_BROWSER_EXTENSION_HOME=${shellQuote(home)}\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)}\n`, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
}

export async function installBrowserExtension({ currentPlatform = platform(), manifestDestinations, runtimeInstaller = installLocalRuntime } = {}) {
  const paths = browserExtensionPaths();
  const runtime = await runtimeInstaller();
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await ensureSecret(paths.secret);
  let metadata = await readJson(paths.metadata);
  const configured = configuredPublishedIdentity();
  const legacyMetadata = Boolean(metadata?.publicKey && metadata?.platform !== "chrome-extension");
  if (legacyMetadata && metadata.extensionId) metadata = { ...metadata, legacyExtensionId: metadata.extensionId };
  if (configured.publicKey) {
    metadata = { ...metadata, publicKey: configured.publicKey };
  }
  if (!metadata?.publicKey || (legacyMetadata && !configured.publicKey)) {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    metadata = { ...metadata, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  }
  const derivedExtensionId = extensionIdFromPublicKey(metadata.publicKey);
  if (configured.extensionId && derivedExtensionId !== configured.extensionId) {
    throw new Error(`${PUBLISHED_EXTENSION_ID_ENV} does not match ${PUBLISHED_EXTENSION_PUBLIC_KEY_ENV} or the existing Fabushi install key.`);
  }
  metadata.extensionId = configured.extensionId || derivedExtensionId;
  // A generated key is useful for an unpacked development install, but it is
  // not a Web Store identity. The packaged desktop Host accepts only this
  // explicit published marker (or the same ID supplied in its environment).
  metadata.publishedExtensionId = configured.extensionId || null;
  metadata.installedAt = new Date().toISOString();

  // Chrome is a first-class Fabushi platform. Keep the old extension source
  // in the repository for rollback/history, but stage only the dedicated
  // product package for new installs.
  const runtimeRoot = runtime.root || packageRoot;
  await cp(join(runtimeRoot, "chrome-platform", "extension"), paths.extension, { recursive: true, force: true });
  const extensionManifestPath = join(paths.extension, "manifest.json");
  const extensionManifest = JSON.parse(await readFile(extensionManifestPath, "utf8"));
  extensionManifest.key = metadata.publicKey;
  await writeFile(extensionManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`, { mode: 0o600 });

  const browserLauncher = paths.launcher;
  const platformLauncher = join(paths.home, currentPlatform === "win32" ? "chrome-platform-host.cmd" : "chrome-platform-host");
  const browserHostScript = runtime.browserHostPath || join(runtimeRoot, "scripts", "browser-extension-host.mjs");
  const platformHostScript = runtime.chromePlatformHostPath || join(runtimeRoot, "scripts", "chrome-platform-host.mjs");
  await writeLauncher(currentPlatform, browserLauncher, browserHostScript, paths.home);
  await writeLauncher(currentPlatform, platformLauncher, platformHostScript, paths.home);

  const allowedOrigins = [`chrome-extension://${metadata.extensionId}/`];
  const nativeHosts = [
    {
      name: NATIVE_HOST_NAME,
      description: "Fabushi bridge for controlling the Chrome browser the user already has open",
      path: browserLauncher,
      type: "stdio",
      allowed_origins: allowedOrigins,
    },
    {
      name: CHROME_PLATFORM_NATIVE_HOST_NAME,
      description: "Fabushi Chrome platform bridge to the signed-in desktop Host",
      path: platformLauncher,
      type: "stdio",
      allowed_origins: allowedOrigins,
    },
  ];

  // Keep a local copy for Windows registry values and make the host identities
  // auditable without putting credentials in the extension package.
  for (const nativeHost of nativeHosts) {
    await writeFile(join(paths.home, `${nativeHost.name}.json`), `${JSON.stringify(nativeHost, null, 2)}\n`, { mode: 0o600 });
  }

  const destinations = manifestDestinations || nativeManifestDestinations(currentPlatform);
  const installedManifests = [];
  for (const destination of destinations) {
    await mkdir(destination.directory, { recursive: true, mode: 0o700 });
    for (const nativeHost of nativeHosts) {
      const target = join(destination.directory, `${nativeHost.name}.json`);
      // Native Messaging manifests contain no credentials and must remain
      // readable by the browser's sandboxed launcher. Keep the containing
      // directory private, but use the documented 0644 manifest mode.
      await writeFile(target, `${JSON.stringify(nativeHost, null, 2)}\n`, { mode: 0o644 });
      await chmod(target, 0o644);
      installedManifests.push({ browser: destination.browser, name: nativeHost.name, path: target });
    }
  }
  if (currentPlatform === "win32" && !manifestDestinations && !process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) {
    await installWindowsRegistry(nativeHosts.map((host) => ({ name: host.name, path: join(paths.home, `${host.name}.json`) })));
  }

  await writeFile(paths.metadata, `${JSON.stringify({
    ...metadata,
    platform: "chrome-extension",
    platformVersion: extensionManifest.version,
    browserNativeHost: NATIVE_HOST_NAME,
    chromePlatformNativeHost: CHROME_PLATFORM_NATIVE_HOST_NAME,
    legacyNativeHost: LEGACY_NATIVE_HOST_NAME,
    manifests: installedManifests,
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    ...paths,
    extensionId: metadata.extensionId,
    manifests: installedManifests,
    platformLauncher,
    publishedExtensionId: metadata.publishedExtensionId,
    runtime: runtime.root ?? null,
  };
}

export async function browserExtensionStatus() {
  const paths = browserExtensionPaths();
  const metadata = await readJson(paths.metadata);
  const manifest = await readJson(join(paths.extension, "manifest.json"));
  return {
    installed: Boolean(metadata?.extensionId && manifest?.key),
    platform: metadata?.platform ?? null,
    version: manifest?.version ?? null,
    extensionId: metadata?.extensionId ?? null,
    publishedExtensionId: metadata?.publishedExtensionId ?? null,
    extensionPath: paths.extension,
    legacyExtensionPath: paths.legacyExtension,
    manifests: metadata?.manifests ?? [],
    browserNativeHost: metadata?.browserNativeHost ?? NATIVE_HOST_NAME,
    chromePlatformNativeHost: metadata?.chromePlatformNativeHost ?? CHROME_PLATFORM_NATIVE_HOST_NAME,
  };
}

/**
 * Remove only the legacy Computer Control native-host registrations after a
 * successful Chrome UI migration. The active Fabushi browser/platform hosts
 * and their shared launcher are intentionally left untouched.
 */
export async function unregisterLegacyNativeMessaging({ currentPlatform = platform(), manifestDestinations } = {}) {
  const destinations = manifestDestinations || nativeManifestDestinations(currentPlatform);
  const removed = [];
  const targets = new Set(destinations.map((destination) => join(destination.directory, `${LEGACY_NATIVE_HOST_NAME}.json`)));
  // Older installs also left an audit copy beside the shared secret. Remove
  // that exact file after the profile UI inventory; never sweep neighboring
  // host registrations or runtime files.
  targets.add(join(browserExtensionPaths().home, `${LEGACY_NATIVE_HOST_NAME}.json`));
  for (const target of targets) {
    try {
      await readFile(target, "utf8");
      await rm(target, { force: true });
      removed.push(target);
    } catch {}
  }
  if (currentPlatform === "win32" && !manifestDestinations && !process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) {
    try {
      await execFileAsync("reg.exe", ["DELETE", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${LEGACY_NATIVE_HOST_NAME}`, "/f"]);
      removed.push("registry:Google\\Chrome");
    } catch {}
    try {
      await execFileAsync("reg.exe", ["DELETE", `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${LEGACY_NATIVE_HOST_NAME}`, "/f"]);
      removed.push("registry:Microsoft\\Edge");
    } catch {}
  }
  return { removed };
}

/**
 * Quarantine a legacy unpacked extension only when the exact old manifest is
 * still present at the private extension path. A Fabushi manifest or an
 * unknown directory is never moved, so the helper cannot sweep user data.
 */
export async function quarantineLegacyBrowserExtension({ trashDirectory } = {}) {
  const paths = browserExtensionPaths();
  const candidates = [paths.legacyExtension, paths.extension];
  let legacyPath = "";
  for (const candidate of candidates) {
    const manifest = await readJson(join(candidate, "manifest.json"));
    if (manifest?.name === "ChatGPT Computer Control Bridge") {
      legacyPath = candidate;
      break;
    }
  }
  if (!legacyPath) {
    return { moved: false, reason: "legacy manifest not present" };
  }
  const parent = trashDirectory ? resolve(trashDirectory) : join(dirname(paths.home), "Trash");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const target = join(parent, `fabushi-legacy-bridge-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await rename(legacyPath, target);
  return { moved: true, path: target };
}
