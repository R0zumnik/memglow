"use strict";
// memglow memory server — version consistency test.
// Asserts that serverInfo.version matches package.json and correctly includes build label.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { makeKb } = require("./fixtures/memory-kb");

test("serverInfo.version matches package.json and includes build label if CHANGELOG differs", () => {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
  try {
    // Get the serverInfo by calling the initialize method
    const initMsg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
    const response = srv.rpc.handle(initMsg);
    const serverInfo = response.result.serverInfo;

    const pkgJson = require("../package.json");
    const changelogPath = path.resolve(__dirname, "../CHANGELOG.md");
    let expectedVersion = pkgJson.version;

    // Check if CHANGELOG has a different internal version
    try {
      const changelog = fs.readFileSync(changelogPath, "utf8");
      const match = changelog.match(/^## ([\d.]+)/m);
      if (match) {
        const internalVersion = match[1];
        if (internalVersion !== pkgJson.version) {
          expectedVersion = `${pkgJson.version} (build ${internalVersion})`;
        }
      }
    } catch {
      // CHANGELOG.md not found or not readable, use package.json version only
    }

    assert.strictEqual(serverInfo.version, expectedVersion, `Expected version "${expectedVersion}" but got "${serverInfo.version}"`);
  } finally {
    srv.close();
    kb.cleanup();
  }
});
