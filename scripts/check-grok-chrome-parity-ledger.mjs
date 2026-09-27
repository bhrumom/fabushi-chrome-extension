import { readFile } from "node:fs/promises";

const ledgerUrl = new URL("../docs/architecture/grok-bot-0.18-chrome-extension-parity-ledger.json", import.meta.url);
const ledger = JSON.parse(await readFile(ledgerUrl, "utf8"));

const required = [
  "reference_path",
  "reference_blob_sha",
  "reference_area",
  "reference_responsibility",
  "reference_ui_effect",
  "chrome_effect",
  "platform_delta",
  "target_paths",
  "target_language",
  "runtime_owner",
  "transport_boundary",
  "parity_class",
  "status",
  "replacement_behavior",
  "tests",
  "production_evidence",
  "preserves_existing_extension_capability",
  "notes",
];

if (ledger.reference_commit !== "a9f633e09d49a85829b8236331b9e21f7e612634") {
  throw new Error("reference commit is not pinned to Grok Bot 0.18 baseline");
}
if (!Array.isArray(ledger.records) || ledger.records.length !== 2046) {
  throw new Error(`expected 2046 ledger rows, got ${ledger.records?.length ?? "none"}`);
}

const paths = new Set();
const statusCounts = new Map();
let sourceCount = 0;
let frontendCount = 0;
const finalMode = process.argv.includes("--final");

for (const [index, row] of ledger.records.entries()) {
  for (const key of required) {
    if (!(key in row)) throw new Error(`row ${index} missing ${key}`);
  }

  if (paths.has(row.reference_path)) throw new Error(`duplicate reference path: ${row.reference_path}`);
  paths.add(row.reference_path);

  if (row.reference_path.startsWith("source/")) sourceCount += 1;
  else if (row.reference_path.startsWith("frontend/")) frontendCount += 1;
  else throw new Error(`out-of-scope path: ${row.reference_path}`);

  if (!/^[0-9a-f]{40}$/.test(row.reference_blob_sha)) {
    throw new Error(`invalid blob SHA: ${row.reference_path}`);
  }

  if (!["mapped", "implementing", "implemented", "verified", "blocked", "not-applicable"].includes(row.status)) {
    throw new Error(`invalid status: ${row.reference_path}`);
  }
  statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);

  if (row.status === "not-applicable" && !String(row.replacement_behavior || "").trim()) {
    throw new Error(`N/A row lacks replacement behavior: ${row.reference_path}`);
  }

  if (!Array.isArray(row.target_paths) || !Array.isArray(row.tests) || !Array.isArray(row.production_evidence)) {
    throw new Error(`row ${row.reference_path} must use array evidence fields`);
  }
}

if (sourceCount !== 1724 || frontendCount !== 322) {
  throw new Error(`scope counts differ from pinned baseline: source=${sourceCount}, frontend=${frontendCount}`);
}

const statusSummary = [...statusCounts.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([status, count]) => `${status}=${count}`)
  .join(", ");

console.log(`Grok Chrome parity ledger: ${ledger.records.length} unique rows (source=${sourceCount}, frontend=${frontendCount}); ${statusSummary}`);

if (finalMode) {
  const nonFinal = ledger.records.filter((row) => !["verified", "not-applicable"].includes(row.status));
  const blocked = ledger.records.filter((row) => row.status === "blocked");
  const weakVerified = ledger.records.filter((row) =>
    row.status === "verified"
    && (
      !Array.isArray(row.tests) || row.tests.length === 0
      || !Array.isArray(row.production_evidence) || row.production_evidence.length === 0
      || !String(row.replacement_behavior || "").trim()
    )
  );

  if (nonFinal.length || blocked.length || weakVerified.length) {
    const sample = nonFinal.slice(0, 12).map((row) => `${row.status}:${row.reference_path}`).join("\n");
    throw new Error(
      [
        `final parity ledger is not closed: nonFinal=${nonFinal.length}, blocked=${blocked.length}, weakVerified=${weakVerified.length}`,
        sample,
      ].filter(Boolean).join("\n")
    );
  }
}
