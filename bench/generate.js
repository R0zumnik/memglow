#!/usr/bin/env node
"use strict";
/**
 * memglow bench — test memory generator.
 *
 *   node bench/generate.js <empty target folder> [--seed 42]
 *
 * Copies demo/memory (fictional) into the target folder, then adds ~195 generated FICTIONAL notes
 * (deterministic: same seed → byte-identical files): clients, projects, people, meetings, habits,
 * reference notes, and 8 large notes (> 5,000 tokens at ≈ bytes ÷ 4) — with [[links]] between
 * them and the facts the questions of bench/questions.json ask about, some deep inside a large
 * note, some reachable only by following a link. The index note (MEMORY.md) gets one short line
 * per generated note, like a real index.
 *
 * Never point this at a real memory: it refuses a non-empty folder.
 */
const fs = require("fs");
const path = require("path");

// ---- deterministic randomness ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(42);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ---- filler text (neutral, never contains a planted answer) ----
const SUBJ = ["The team", "The client", "Our setup", "This service", "The pipeline", "The staging server", "The release process", "The dashboard", "The import job", "The mobile app", "The design review", "The weekly report", "The test suite", "The backlog", "The documentation"];
const VERB = ["now relies on", "was simplified around", "still depends on", "moved away from", "is documented next to", "was reviewed against", "needs a follow-up on", "was split from", "is monitored through", "keeps a short note about"];
const OBJ = ["the shared checklist", "a nightly export", "the feature flags", "the onboarding script", "the cache layer", "a read-only replica", "the image registry", "the access review", "the error budget", "the translation files", "the search index", "the billing webhook", "the audit trail", "a small retry queue", "the status page"];
const TAIL = ["after the last incident.", "to keep things predictable.", "until the next review.", "as agreed with the owner.", "because it was easier to explain.", "for the coming quarter.", "with a written rollback plan.", "and nobody objected.", "once the tests were green.", "to save a round trip."];
function sentence() { return `${pick(SUBJ)} ${pick(VERB)} ${pick(OBJ)} ${pick(TAIL)}`; }
function para(n) { return Array.from({ length: n }, sentence).join(" "); }
function bullets(n) { return Array.from({ length: n }, () => "- " + sentence()).join("\n"); }

const FIRST = ["Aino", "Bruno", "Chiara", "Darius", "Elif", "Farid", "Greta", "Hugo", "Ilse", "Jonas", "Kaito", "Lena", "Mateo", "Nadia", "Oskar", "Priya", "Quentin", "Rosa", "Sven", "Tara", "Umar", "Vera", "Wim", "Xenia", "Yusuf", "Zora", "Anouk", "Bastian", "Carmen", "Dov"];
const LAST = ["Aalto", "Berger", "Costa", "Duval", "Eriksen", "Fischer", "Gallo", "Horvat", "Ivanova", "Jansen", "Kowalski", "Laine", "Moreau", "Nieminen", "Olsen", "Petrov", "Quist", "Rossi", "Silva", "Tanaka"];
const CODENAMES = ["anvil", "beacon", "cobalt", "delta-dawn", "ember", "falcon", "garnet", "heron", "ivy", "juniper", "keystone", "larch", "meadow", "nimbus", "onyx", "pine", "quartz", "raven", "sable", "tundra", "umber", "vellum", "willow", "yarrow", "zephyr"];
const COMPANIES = ["alder-print", "brightwater-dental", "copper-kettle", "dune-surf", "evergreen-gym", "fenwick-law", "granite-bikes", "hollow-pines-hotel", "iris-florist", "jade-tea-house", "kiln-pottery", "linden-school", "maple-movers", "nova-optics", "oak-and-ash", "pebble-pet-care", "quarry-climbing", "riverside-vets", "saffron-kitchen", "tidal-yachts", "upland-farms", "violet-salon", "westbrook-library", "yellowfin-sushi", "zenith-physio"];
const TOPICS = ["caching", "logging", "feature-flags", "migrations", "accessibility", "i18n", "monitoring", "testing", "code-review", "dependency-updates", "search", "image-optimisation", "email-delivery", "payments", "auth", "pdf-export", "cron-jobs", "observability", "secrets-rotation", "load-testing"];
const title = (slug) => slug;

const notes = new Map(); // relPath → content
const index = [];        // [slug, description]
function note(folder, slug, { theme, subtheme, description, body }) {
  const fm = `---\ntitle: ${title(slug)}\ntheme: ${theme}\nsubtheme: ${subtheme}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  notes.set(path.join(folder, slug + ".md"), fm + body.trim() + "\n");
  index.push([slug, description]);
}
const link = (s) => `[[${s}]]`;

// ---- planted, question-bearing notes (bench/questions.json refers to these) ----
function planted() {
  note("projects", "project-kestrel", { theme: "projects", subtheme: "client-work", description: "Kestrel: booking portal for Marlow Bakery, launch planned in spring 2026",
    body: `# Kestrel\n\nBooking portal for ${link("client-marlow-bakery")}.\n\n## Stack\n- Node.js API, PostgreSQL, a small React front end.\n- The production database listens on port 5432, like everywhere else.\n- The staging database for Kestrel listens on port 6439, to avoid clashing with the old prototype.\n\n## Notes\n${bullets(4)}\n- See also: ${link("meeting-2026-03-04")}, ${link("person-ingrid")}.` });
  note("people", "client-marlow-bakery", { theme: "people", subtheme: "clients", description: "Marlow Bakery: small bakery chain, client of the Kestrel project",
    body: `# Marlow Bakery\n\nThree shops, one central kitchen. Project: ${link("project-kestrel")}.\n\n## Billing\n- Invoices for Marlow Bakery go out on the 12th of each month.\n- Payment terms: 30 days.\n\n## Notes\n${bullets(3)}` });
  note("people", "person-ingrid", { theme: "people", subtheme: "contacts", description: "Ingrid Valtersen: product owner at Marlow Bakery",
    body: `# Ingrid Valtersen\n\nProduct owner on ${link("project-kestrel")} for ${link("client-marlow-bakery")}.\n\n## Working with Ingrid\n- Ingrid's preferred meeting slot is Tuesday at 14:30.\n- Prefers a short written agenda the day before.\n\n## Notes\n${bullets(3)}` });
  note("knowledge", "reference-tls-renewal", { theme: "knowledge", subtheme: "ops", description: "TLS certificates: renewal routine for client and home lab domains",
    body: `# TLS renewal\n\n## Routine\n- Certificates are renewed 21 days before expiry, by the ACME client.\n- A failed renewal sends an alert to the ops channel.\n\n## Notes\n${bullets(4)}` });
  note("habits", "feedback-commit-messages", { theme: "habits", subtheme: "rules", description: "Commit messages: format rules the user wants",
    body: `# Commit messages\n\n- The subject line of a commit message must stay under 64 characters.\n- Use the imperative mood; explain the why in the body.\n\n## Why\n${para(3)}` });
  note("projects", "project-lantern", { theme: "projects", subtheme: "client-work", description: "Lantern: tile catalogue and quote tool",
    body: `# Lantern\n\nCatalogue and quote tool. Client: ${link("client-ostrava-tiles")}.\n\n## Status\n- Kickoff held in June 2025, see the meeting log ${link("log-meetings-2025")}.\n${bullets(3)}` });
  note("people", "client-ostrava-tiles", { theme: "people", subtheme: "clients", description: "Ostrava Tiles: ceramic tile distributor",
    body: `# Ostrava Tiles\n\nCeramic tile distributor, two warehouses.\n\n## Contacts\n- Accountant: Petra Novakova (handles all invoices and purchase orders).\n- Operations: a rotating warehouse lead.\n\n## Notes\n${bullets(3)}` });
  note("people", "person-dmitri", { theme: "people", subtheme: "contacts", description: "Dmitri: freelance developer the user subcontracts to",
    body: `# Dmitri\n\nFreelance developer. Dmitri leads ${link("project-orchard")} day to day.\n\n## Notes\n- Prefers pull requests under 300 lines.\n${bullets(3)}` });
  note("projects", "project-orchard", { theme: "projects", subtheme: "client-work", description: "Orchard: inventory sync for Upland Farms",
    body: `# Orchard\n\nInventory sync between the farm shop and the web store of ${link("client-upland-farms")}.\n\n## Release rules\n- Production deploys happen on Wednesdays after 16:00, never on Fridays.\n- Staging is redeployed on every merge.\n\n## Decisions\n- The message queue choice is recorded in ${link("log-decisions")}.\n${bullets(3)}` });
  note("people", "client-fjord-analytics", { theme: "people", subtheme: "clients", description: "Fjord Analytics: data consultancy, dashboard project",
    body: `# Fjord Analytics\n\nData consultancy. Their main contact is ${link("person-solveig")}.\n\n## Notes\n${bullets(4)}` });
  note("people", "person-solveig", { theme: "people", subtheme: "contacts", description: "Solveig Aas: head of delivery at Fjord Analytics",
    body: `# Solveig Aas\n\nHead of delivery at ${link("client-fjord-analytics")}.\n\n## Reaching Solveig\n- Phone extension 4471 at the Fjord Analytics office.\n- Email for anything written.\n\n## Notes\n${bullets(2)}` });
  note("projects", "project-harbor", { theme: "projects", subtheme: "client-work", description: "Harbor: hosting platform the user runs for three clients",
    body: `# Harbor\n\nManaged hosting for three small clients. Runbook: ${link("reference-runbook-harbor")}.\n\n## Notes\n${bullets(4)}` });
  note("projects", "meeting-2026-03-04", { theme: "projects", subtheme: "meetings", description: "Meeting of 2026-03-04 with Marlow Bakery about Kestrel",
    body: `# Meeting 2026-03-04 — Kestrel\n\nWith ${link("person-ingrid")} about ${link("project-kestrel")}.\n\n## Decisions\n- Decided to move the Kestrel launch to 2026-05-19, after the Easter rush.\n- Keep the old booking form online for two more weeks.\n\n## Notes\n${bullets(3)}` });
}

// ---- large notes (> 5,000 tokens), with planted facts deep inside ----
function bigNote(slug, folder, meta, intro, sections) {
  note(folder, slug, { ...meta, body: `# ${slug}\n\n${intro}\n\n` + sections.map(([h, b]) => `## ${h}\n\n${b}`).join("\n\n") });
}
function large() {
  // Harbor runbook: failover lag (Q) and backup retention (Q, reached through project-harbor).
  const rb = [];
  const parts = ["Overview", "Access", "Deploys", "Monitoring", "Alerts", "Failover", "DNS", "Certificates", "Backups", "Restores", "Scaling", "Costs", "Log retention", "On-call", "Postmortems", "Decommissioning"];
  for (const h of parts) {
    let b = para(int(10, 13)) + "\n\n" + bullets(int(6, 9));
    if (h === "Failover") b = "- Maximum replication lag allowed before failover: 42 seconds.\n- Failover is manual, two people on the call.\n\n" + b;
    if (h === "Backups") b = para(3) + "\n\n- Harbor backups are kept for 35 days, then pruned.\n\n" + b;
    rb.push([h, b]);
  }
  bigNote("reference-runbook-harbor", "knowledge", { theme: "knowledge", subtheme: "ops", description: "Harbor runbook: deploys, monitoring, failover, backups — long" }, `Runbook of ${link("project-harbor")}.`, rb);

  // Vendor catalogue: account number (Q).
  const vendors = ["Aster Cables", "Birch Office", "Cinder Labs", "Drift Hosting", "Echo Print", "Flint Hardware", "Gale Networks", "Hearth Coffee Supply", "Inkwell Stationery", "Juno Couriers", "Kite Insurance", "Lumen Lighting", "Mosaic Furniture", "Nettle Cleaning", "Orbit Telecom", "Pylon Power", "Quillon Supplies", "Rook Security", "Slate Accounting", "Thistle Catering", "Ursa Storage", "Vane Logistics", "Wren Training"];
  bigNote("reference-vendor-catalog", "knowledge", { theme: "knowledge", subtheme: "admin", description: "Vendor catalogue: every supplier, account numbers, terms — long" }, "All suppliers of the business, one section each.",
    vendors.map((v) => {
      const acc = v === "Quillon Supplies" ? "QS-88213" : v.split(" ")[0].slice(0, 2).toUpperCase() + "-" + int(10000, 99999);
      return [v, `- Account number: ${acc}\n- Terms: ${pick(["net 30", "net 45", "prepaid", "net 15"])}\n- Contact: ${pick(FIRST)} ${pick(LAST)}\n\n${para(int(5, 8))}\n\n${bullets(int(3, 5))}`];
    }));

  // Meeting log 2025: Lantern kickoff budget (Q), with a distractor review.
  const meetings = [];
  for (let m = 1; m <= 12; m++) {
    for (let k = 0; k < 2; k++) {
      const d = `2025-${String(m).padStart(2, "0")}-${String(int(2, 27)).padStart(2, "0")}`;
      meetings.push([`${d} — ${pick(["Weekly sync", "Planning", "Retro", "Client call", "Budget review"])}`, para(int(4, 7)) + "\n\n" + bullets(int(3, 5))]);
    }
  }
  meetings.splice(11, 0, ["2025-06-18 — Lantern kickoff", `With ${link("client-ostrava-tiles")}. ${para(3)}\n\n- Agreed budget for Lantern: 18,500 euros, fixed price.\n- First demo in four weeks.\n\n${bullets(3)}`]);
  meetings.splice(20, 0, ["2025-10-02 — Lantern review", `${para(3)}\n\n- Change requests estimated separately; nothing added to the fixed price yet.\n\n${bullets(3)}`]);
  bigNote("log-meetings-2025", "projects", { theme: "projects", subtheme: "meetings", description: "Meeting log for 2025: one section per meeting — long" }, "Every client and team meeting of 2025, oldest first.", meetings);

  // Network inventory: rack B switch IP (Q).
  bigNote("reference-network-inventory", "knowledge", { theme: "knowledge", subtheme: "ops", description: "Network inventory: racks, switches, addresses — long" }, "Physical and logical inventory of the office and home lab network.",
    ["Rack A", "Rack B", "Rack C", "Wi-Fi", "VLANs", "Firewall", "VPN", "Printers", "Cameras", "IoT", "Spare parts", "Cabling", "Power", "Labels", "Changes"].map((h) => {
      let b = para(int(10, 13)) + "\n\n" + bullets(int(5, 8));
      if (h === "Rack B") b = "- The switch in rack B is named sw-b-07; its management IP is 10.20.7.4.\n- Uplink: two bonded ports.\n\n" + b;
      if (h === "Rack A") b = "- The switch in rack A is named sw-a-02 and is managed from the controller only.\n\n" + b;
      return [h, b];
    }));

  // API catalogue: Ledger rate limit (Q).
  bigNote("reference-api-catalog", "knowledge", { theme: "knowledge", subtheme: "apis", description: "Catalogue of the third-party APIs used by client projects — long" }, "Every external API, its auth, limits and quirks.",
    ["Ledger API", "Maps API", "SMS API", "Email API", "Weather API", "Payments API", "Shipping API", "Tax API", "Calendar API", "Storage API", "Translation API", "Analytics API", "Search API", "Identity API"].map((h) => {
      let b = `- Auth: ${pick(["API key", "OAuth client credentials", "signed requests"])}\n- Rate limit: ${h === "Ledger API" ? "240 requests per minute per key" : int(10, 50) * 100 + " requests per hour"}\n\n` + para(int(10, 13)) + "\n\n" + bullets(int(5, 7));
      return [h, b];
    }));

  // Decision log: Orchard queue (Q).
  const decisions = [];
  for (let i = 1; i <= 30; i++) {
    let h = `Decision ${i} — ${pick(["Hosting", "Framework", "Testing", "Naming", "Branching", "Monitoring", "Pricing", "Support hours", "Backups", "Logging"])}`;
    let b = para(int(4, 7)) + "\n\n" + bullets(int(2, 4));
    if (i === 17) { h = "Decision 17 — Queue choice"; b = `For ${link("project-orchard")}: we chose NATS over RabbitMQ (lighter to run, enough guarantees for inventory events).\n\n` + b; }
    decisions.push([h, b]);
  }
  bigNote("log-decisions", "knowledge", { theme: "knowledge", subtheme: "decisions", description: "Decision log: every technical and business decision with its reason — long" }, "One section per decision, numbered, oldest first.", decisions);

  // Glossary: Bramble (Q).
  const terms = ["Acorn", "Basalt", "Bramble", "Cairn", "Dovetail", "Eddy", "Fathom", "Gorse", "Hinge", "Inlet", "Jetty", "Kestrel window", "Lichen", "Mortar", "Nook", "Oxbow", "Pumice", "Quill", "Rill", "Scree", "Tarn", "Umbra", "Vale", "Weir"];
  bigNote("reference-glossary", "knowledge", { theme: "knowledge", subtheme: "general", description: "Glossary of internal names and jargon — long" }, "Internal names used in notes, tickets and chats.",
    terms.map((t) => [t, (t === "Bramble" ? "Bramble: the internal name of the nightly data reconciliation job that compares orders and payments.\n\n" : `${t}: an internal name, see the related tickets.\n\n`) + para(int(6, 8)) + "\n\n" + bullets(int(3, 5))]));

  // Onboarding guide: VPN profile (Q).
  bigNote("reference-onboarding-guide", "knowledge", { theme: "knowledge", subtheme: "admin", description: "Onboarding guide for subcontractors — long" }, "What a new subcontractor needs in the first week.",
    ["Welcome", "Accounts", "Laptop setup", "Repositories", "Code style", "Reviews", "Testing", "Deploys", "Security", "Communication", "Time tracking", "Invoicing", "Holidays", "Offboarding"].map((h) => {
      let b = para(int(10, 13)) + "\n\n" + bullets(int(5, 8));
      if (h === "Laptop setup") b = "- Install the VPN client and import the profile called corp-north-2.\n- Full-disk encryption is mandatory.\n\n" + b;
      return [h, b];
    }));
}

// ---- generated background notes ----
function background() {
  const companies = shuffle(COMPANIES).filter((c) => c !== "upland-farms");
  const codes = shuffle(CODENAMES);
  const people = [];
  for (let i = 0; i < 26; i++) {
    const f = FIRST[i], l = pick(LAST), slug = "person-" + f.toLowerCase();
    people.push(slug);
    note("people", slug, { theme: "people", subtheme: "contacts", description: `${f} ${l}: ${pick(["designer", "developer", "accountant", "project manager", "tester", "copywriter", "sysadmin"])} met through client work`,
      body: `# ${f} ${l}\n\n${para(int(2, 4))}\n\n## Notes\n${bullets(int(2, 5))}` });
  }
  note("people", "client-upland-farms", { theme: "people", subtheme: "clients", description: "Upland Farms: organic farm shop, client of Orchard",
    body: `# Upland Farms\n\nFarm shop and web store. Project: ${link("project-orchard")}.\n\n## Notes\n${bullets(4)}` });
  const projects = [];
  for (let i = 0; i < 24; i++) {
    const c = companies[i], code = codes[i], slug = "project-" + code, cl = "client-" + c;
    projects.push(slug);
    const p1 = pick(people), p2 = pick(people);
    note("people", cl, { theme: "people", subtheme: "clients", description: `${c.replace(/-/g, " ")}: client since ${int(2019, 2025)}`,
      body: `# ${c}\n\n${para(2)} Project: ${link(slug)}. Contact: ${link(p1)}.\n\n## Notes\n${bullets(int(2, 4))}` });
    note("projects", slug, { theme: "projects", subtheme: "client-work", description: `${code}: ${pick(["web shop", "booking tool", "internal dashboard", "mobile app", "data import", "website redesign"])} for ${c.replace(/-/g, " ")}`,
      body: `# ${code}\n\nClient: ${link(cl)}. Team: ${link(p1)}, ${link(p2)}.\n\n## Stack\n${bullets(3)}\n\n## Status\n${para(int(3, 6))}\n\n## Notes\n${bullets(int(2, 4))}` });
  }
  for (let i = 0; i < 50; i++) {
    const t = TOPICS[i % TOPICS.length], slug = `reference-${t}${i >= TOPICS.length ? "-" + (i - TOPICS.length + 2) : ""}`;
    const secs = int(2, 5);
    let body = `# ${t.replace(/-/g, " ")}\n\n${para(2)}\n\n`;
    for (let s = 0; s < secs; s++) body += `## ${pick(["Rules", "Setup", "Pitfalls", "Checklist", "Examples", "History", "Open questions"])}\n${bullets(int(3, 6))}\n\n`;
    body += `See also: ${link(pick(projects))}, ${link("reference-" + pick(TOPICS))}.`;
    note("knowledge", slug, { theme: "knowledge", subtheme: pick(["dev", "ops", "general"]), description: `${t.replace(/-/g, " ")}: how it is done on client projects`, body });
  }
  for (let i = 0; i < 32; i++) {
    const d = `2026-${String(int(1, 9)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`, slug = `meeting-${d}-${i}`;
    if (slug.startsWith("meeting-2026-03-04")) continue;
    const pr = pick(projects);
    note("projects", slug, { theme: "projects", subtheme: "meetings", description: `Meeting of ${d} about ${pr.replace("project-", "")}`,
      body: `# Meeting ${d}\n\nAbout ${link(pr)} with ${link(pick(people))}.\n\n## Decisions\n${bullets(int(2, 4))}\n\n## Notes\n${para(int(2, 4))}` });
  }
  const habits = ["tests-before-merge", "small-pull-requests", "written-agendas", "no-friday-deploys", "changelog-every-release", "plain-language", "timebox-research", "ask-before-deleting", "screenshots-in-tickets", "one-question-at-a-time", "dark-mode-first", "metric-units"];
  for (const h of habits) note("habits", "feedback-" + h, { theme: "habits", subtheme: "rules", description: `${h.replace(/-/g, " ")}: a working rule the user asked for`, body: `# ${h.replace(/-/g, " ")}\n\n${para(2)}\n\n## Why\n${bullets(2)}` });
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const si = args.indexOf("--seed");
  if (si >= 0) rnd = mulberry32(Number(args[si + 1]) || 42);
  if (!target) { console.error("usage: node bench/generate.js <empty folder> [--seed 42]"); process.exit(2); }
  fs.mkdirSync(target, { recursive: true });
  if (fs.readdirSync(target).length) { console.error("refusing: target folder is not empty"); process.exit(2); }
  const demo = path.join(__dirname, "..", "demo", "memory");
  fs.cpSync(demo, target, { recursive: true });
  planted(); large(); background();
  for (const [rel, body] of notes) {
    const f = path.join(target, rel);
    if (fs.existsSync(f)) throw new Error("collision: " + rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  const idx = path.join(target, "MEMORY.md");
  fs.appendFileSync(idx, "\n## More notes\n\n" + index.map(([s, d]) => `- ${link(s)} — ${d}`).join("\n") + "\n");
  let total = 0, n = 0, big = 0;
  for (const f of walk(target)) { const b = fs.statSync(f).size; total += b; n++; if (b / 4 > 5000) big++; }
  console.log(JSON.stringify({ notes: n, generated: notes.size, large: big, approxTokens: Math.round(total / 4) }));
}
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith(".md")) yield p; } }

if (require.main === module) main();
module.exports = { mulberry32 };
