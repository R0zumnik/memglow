#!/usr/bin/env node
"use strict";
/**
 * Detached sender used by the agent adapters: POST one activity event to the viewer.
 *   node send-activity.js <viewer-url> <base64 JSON body>     (token in MEMGLOW_TOKEN)
 * Gives up after 3 s; prints nothing; a lost event does not matter.
 */
(async () => {
  try {
    const [url, payload] = process.argv.slice(2);
    await fetch(String(url).replace(/\/+$/, "") + "/api/activity", {
      method: "POST",
      headers: { Authorization: "Bearer " + (process.env.MEMGLOW_TOKEN || ""), "Content-Type": "application/json" },
      body: Buffer.from(payload || "", "base64").toString("utf8"),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* silent */ }
})();
