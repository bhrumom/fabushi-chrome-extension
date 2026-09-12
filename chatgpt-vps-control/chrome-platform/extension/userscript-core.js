const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 64;
const MAX_GRANTS = 32;

const SUPPORTED_GRANTS = new Set([
  "none",
  "GM_addStyle",
  "GM_deleteValue",
  "GM_getValue",
  "GM_listValues",
  "GM_openInTab",
  "GM_setValue",
]);

const text = (value, limit = 512) => String(value ?? "").replace(/\0/g, "").trim().slice(0, limit);

function byteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function scriptId(metadata, sourcePluginId = "") {
  const owner = text(sourcePluginId, 160) || `${metadata.namespace || "local"}:${metadata.name}`;
  const readable = owner.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "userscript";
  return `fabushi-userscript-${readable}-${hashText(`${owner}:${metadata.name}`)}`;
}

function parseMetadata(source) {
  const normalized = String(source ?? "").replace(/^\uFEFF/, "");
  const block = normalized.match(/==UserScript==([\s\S]*?)==\/UserScript==/i);
  if (!block) throw new Error("未找到油猴脚本元数据区块（==UserScript==）。");
  const metadata = { matches: [], includes: [], excludes: [], grants: [] };
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^\s*\/\/\s*@([A-Za-z][\w-]*)\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = text(match[2], 2048);
    if (key === "match") metadata.matches.push(value);
    else if (key === "include") metadata.includes.push(value);
    else if (key === "exclude") metadata.excludes.push(value);
    else if (key === "grant") metadata.grants.push(value || "none");
    else if (key === "run-at") metadata.runAt = value || "document-idle";
    else if (key === "noframes") metadata.noFrames = true;
    else if (["name", "namespace", "version", "description", "author", "icon"].includes(key)) {
      metadata[key] = value;
    }
  }
  if (!metadata.name) throw new Error("油猴脚本缺少 @name。");
  if (!metadata.version) metadata.version = "0.0.0";
  if (!metadata.namespace) metadata.namespace = "fabushi.local";
  if (!metadata.description) metadata.description = "Fabushi 用户脚本";
  if (!metadata.runAt) metadata.runAt = "document-idle";
  if (!metadata.matches.length && !metadata.includes.length) {
    throw new Error("油猴脚本至少需要一个 @match 或 @include。");
  }
  if ([...metadata.matches, ...metadata.includes, ...metadata.excludes].some((value) => !value || value.length > 512)) {
    throw new Error("油猴脚本匹配规则无效或过长。");
  }
  if (metadata.matches.length + metadata.includes.length > MAX_MATCHES || metadata.excludes.length > MAX_MATCHES) {
    throw new Error("油猴脚本匹配规则过多。");
  }
  metadata.grants = [...new Set(metadata.grants.length ? metadata.grants : ["none"])]
    .filter(Boolean)
    .slice(0, MAX_GRANTS);
  const unsupported = metadata.grants.filter((grant) => !SUPPORTED_GRANTS.has(grant));
  if (unsupported.length) {
    throw new Error(`Fabushi 暂不支持这些 @grant：${unsupported.join(", ")}。请把依赖打包到脚本中。`);
  }
  if (!new Set(["document-start", "document-end", "document-idle"]).has(metadata.runAt)) {
    throw new Error(`不支持的 @run-at：${metadata.runAt}。`);
  }
  metadata.grants = metadata.grants.filter((grant) => grant !== "none");
  return { ...metadata, source: normalized };
}

export function normalizeUserScript(source, options = {}) {
  const normalized = String(source ?? "").replace(/^\uFEFF/, "");
  if (!normalized.trim()) throw new Error("油猴脚本内容为空。");
  if (byteLength(normalized) > MAX_SOURCE_BYTES) throw new Error("油猴脚本超过 2 MiB 大小限制。");
  const metadata = parseMetadata(normalized);
  const forbiddenDirectives = ["require", "resource", "downloadurl", "updateurl", "connect"];
  const header = normalized.match(/==UserScript==([\s\S]*?)==\/UserScript==/i)?.[1] || "";
  for (const directive of forbiddenDirectives) {
    if (new RegExp(`^\\s*//\\s*@${directive}\\b`, "im").test(header)) {
      throw new Error(`Fabushi 不加载远程 @${directive}；请把依赖打包进用户脚本后再安装。`);
    }
  }
  const blockedCode = [
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\b|(^|[^\w.])Function\s*\(/, "Function constructor"],
    [/\bimport\s*\(/, "dynamic import"],
    [/\bWebAssembly\s*\.\s*(compile|instantiate)\s*\(/, "dynamic WebAssembly"],
  ];
  for (const [pattern, label] of blockedCode) {
    if (pattern.test(normalized)) throw new Error(`Fabushi 用户脚本不允许 ${label}。`);
  }
  return {
    id: scriptId(metadata, options.sourcePluginId),
    name: metadata.name,
    namespace: metadata.namespace,
    version: metadata.version,
    description: metadata.description,
    matches: [...metadata.matches, ...metadata.includes],
    excludes: metadata.excludes,
    grants: metadata.grants,
    runAt: metadata.runAt,
    noFrames: metadata.noFrames === true,
    source: normalized,
    sourcePluginId: text(options.sourcePluginId, 160) || null,
    sourcePluginVersion: text(options.sourcePluginVersion, 100) || null,
    commands: Array.isArray(options.commands) ? options.commands.slice(0, 64).map((value) => text(value, 120)).filter(Boolean) : [],
    installedAt: Number(options.installedAt) || Date.now(),
    enabled: options.enabled !== false,
  };
}

function globToRegExp(pattern, { matchPattern = false } = {}) {
  const value = String(pattern ?? "").trim();
  if (value === "<all_urls>") return /^https?:\/\/[^/]+(?:\/.*)?$/i;
  if (!value) return null;
  if (matchPattern) {
    const parsed = value.match(/^([^:]+):\/\/([^/]*)(\/.*)?$/);
    if (!parsed) return globToRegExp(value);
    const scheme = parsed[1] === "*" ? "https?" : parsed[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const host = parsed[2] === "*"
      ? "[^/]+"
      : parsed[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*");
    const path = (parsed[3] || "/*").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
    return new RegExp(`^${scheme}:\\/\\/${host}${path}$`, "i");
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function userScriptMatches(record, url) {
  const target = String(url ?? "");
  if (!/^https?:\/\//i.test(target)) return false;
  const matches = Array.isArray(record?.matches) ? record.matches : [];
  const includes = matches.some((pattern) => globToRegExp(pattern, { matchPattern: pattern.includes("://") })?.test(target));
  if (!includes) return false;
  return !(Array.isArray(record?.excludes) && record.excludes.some((pattern) => globToRegExp(pattern)?.test(target)));
}

export function publicUserScript(record) {
  if (!record || typeof record !== "object") return null;
  const { source: _source, ...publicRecord } = record;
  return publicRecord;
}

export { MAX_SOURCE_BYTES, SUPPORTED_GRANTS };
