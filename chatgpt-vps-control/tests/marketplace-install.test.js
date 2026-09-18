import test from "node:test";
import assert from "node:assert/strict";
import { marketplaceDisplayVersion } from "../chrome-platform/extension/marketplace-install.js";

test("Marketplace cards show the installed userscript metadata version", () => {
  const item = {
    pluginId: "chatgpt-auto-confirm",
    latestVersion: "2.9.37",
    surfaces: [{ id: "userscript", kind: "userscript" }],
  };
  const userscript = {
    version: "2.9.39",
    sourcePluginVersion: "2.9.39",
  };
  assert.equal(marketplaceDisplayVersion(item, null, userscript), "2.9.39");
  assert.equal(marketplaceDisplayVersion(item, null, null), "2.9.37");
});
