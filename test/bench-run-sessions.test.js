"use strict";
// bench/run.js --mode sessions (stage 0.4.1 of the v0.5 engine roadmap): the pure pieces only —
// prompt building, per-question grading of one combined answer, session-file validation, planning
// and the --dry-run cost estimate. Never spawns `claude` or a proxy (bench/RESULTS.md's "How to
// reproduce" is the only place that does, by hand).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildSessionPrompt, parseSessionAnswer, loadSessions, planSessions, avgCostPerQuestion, formatSessionPlan, SESSIONS_FILE_DEFAULT,
} = require("../bench/run.js");

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "bench", "questions.json"), "utf8")).questions;

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("bench/sessions.json: every question id it refers to exists in bench/questions.json, at least 2 sessions, no session empty", () => {
  const sessions = loadSessions(SESSIONS_FILE_DEFAULT, QUESTIONS);
  assert.ok(sessions.length >= 2, "at least a couple of real sessions shipped");
  for (const s of sessions) {
    assert.ok(s.questions.length >= 1, `${s.id} has at least one question`);
    assert.ok(typeof s.topic === "string" && s.topic, `${s.id} has a topic label`);
  }
  // at least one multi-question session: the whole point of this mode
  assert.ok(sessions.some((s) => s.questions.length >= 2), "at least one session asks more than one question");
});

test("loadSessions: throws on an unknown question id, on an empty session, never on a reasonable file", () => {
  const dir = tmpDir("memglow-bench-sessions-");
  const bad1 = path.join(dir, "bad1.json");
  fs.writeFileSync(bad1, JSON.stringify({ sessions: [{ id: "x", questions: ["q01", "does-not-exist"] }] }));
  assert.throws(() => loadSessions(bad1, QUESTIONS), /unknown question id "does-not-exist"/);

  const bad2 = path.join(dir, "bad2.json");
  fs.writeFileSync(bad2, JSON.stringify({ sessions: [{ id: "empty", questions: [] }] }));
  assert.throws(() => loadSessions(bad2, QUESTIONS), /no questions/);

  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, JSON.stringify({ sessions: [{ id: "a", topic: "A topic", questions: ["q01", "q02"] }] }));
  const sessions = loadSessions(good, QUESTIONS);
  assert.deepStrictEqual(sessions.map((s) => s.id), ["a"]);
  assert.strictEqual(sessions[0].topic, "A topic");
  assert.deepStrictEqual(sessions[0].questions.map((q) => q.id), ["q01", "q02"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadSessions: a session without a topic falls back to its id", () => {
  const dir = tmpDir("memglow-bench-sessions-");
  const f = path.join(dir, "s.json");
  fs.writeFileSync(f, JSON.stringify({ sessions: [{ id: "no-topic", questions: ["q01"] }] }));
  const sessions = loadSessions(f, QUESTIONS);
  assert.strictEqual(sessions[0].topic, "no-topic");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildSessionPrompt: every question numbered in order, answer format explained, no guessing allowed", () => {
  const qs = [{ id: "q01", q: "On which port does X listen?" }, { id: "q02", q: "What day is Y sent?" }];
  const prompt = buildSessionPrompt(qs);
  assert.match(prompt, /Q1: On which port does X listen\?/);
  assert.match(prompt, /Q2: What day is Y sent\?/);
  assert.match(prompt, /IN ORDER/);
  assert.match(prompt, /A<n>: /);
  assert.match(prompt, /could not find/);
});

test("parseSessionAnswer: grades each numbered line against its own question, independently", () => {
  const qs = [{ id: "q01", expect: "\\b42\\b" }, { id: "q02", expect: "tuesday" }, { id: "q03", expect: "\\b99\\b" }];
  const answer = "A1: The port is 42.\nA2: The meeting is on Tuesday.\nA3: I could not find that.";
  const g = parseSessionAnswer(answer, qs);
  assert.deepStrictEqual(g.per.map((p) => p.correct), [true, true, false]);
  assert.deepStrictEqual(g.per.map((p) => p.answered), [true, true, true]);
  assert.strictEqual(g.correctCount, 2);
  assert.strictEqual(g.total, 3);
});

test("parseSessionAnswer: a missing numbered line falls back to testing the regex against the whole answer (lenient)", () => {
  const qs = [{ id: "q01", expect: "\\b42\\b" }, { id: "q02", expect: "tuesday" }];
  // the model answered both facts but ignored the "A<n>:" instruction entirely
  const answer = "The port is 42 and the meeting is on Tuesday.";
  const g = parseSessionAnswer(answer, qs);
  assert.deepStrictEqual(g.per.map((p) => p.answered), [false, false]);
  assert.deepStrictEqual(g.per.map((p) => p.correct), [true, true]);
});

test("parseSessionAnswer: case-insensitive, order of lines in the answer does not matter", () => {
  const qs = [{ id: "q01", expect: "alpha" }, { id: "q02", expect: "beta" }];
  const answer = "A2: It mentions BETA.\nA1: It mentions ALPHA.";
  const g = parseSessionAnswer(answer, qs);
  assert.deepStrictEqual(g.per.map((p) => p.correct), [true, true]);
});

test("planSessions: session × variant × rep, shuffled deterministically by seed, same seed = same order", () => {
  const sessions = [{ id: "a", topic: "A", questions: [{ id: "q01" }] }, { id: "b", topic: "B", questions: [{ id: "q02" }] }];
  const p1 = planSessions(sessions, ["A", "C"], 2, 7);
  const p2 = planSessions(sessions, ["A", "C"], 2, 7);
  assert.strictEqual(p1.length, 2 * 2 * 2);
  assert.deepStrictEqual(p1.map((x) => x.s.id + x.v + x.r), p2.map((x) => x.s.id + x.v + x.r));
  const p3 = planSessions(sessions, ["A", "C"], 2, 9);
  assert.notDeepStrictEqual(p1.map((x) => x.s.id + x.v + x.r), p3.map((x) => x.s.id + x.v + x.r), "a different seed reshuffles");
});

test("avgCostPerQuestion: averages costUsd of exit-0/success runs only, across every *.jsonl in the folder; null when there is nothing to read", () => {
  const dir = tmpDir("memglow-bench-avgcost-");
  fs.writeFileSync(path.join(dir, "a.jsonl"), [
    JSON.stringify({ exit: 0, subtype: "success", costUsd: 0.01 }),
    JSON.stringify({ exit: 0, subtype: "success", costUsd: 0.03 }),
    JSON.stringify({ exit: 1, subtype: "error_during_execution", costUsd: 0.5 }), // ignored: not a success
    "not json at all", // ignored: unparsable
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "b.jsonl"), JSON.stringify({ exit: 0, subtype: "success", costUsd: 0.02 }) + "\n");
  const avg = avgCostPerQuestion(dir);
  assert.strictEqual(avg.samples, 3);
  assert.ok(Math.abs(avg.avg - 0.02) < 1e-9);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.strictEqual(avgCostPerQuestion(path.join(dir, "does-not-exist")), null);
});

test("formatSessionPlan: human-readable plan, with and without a cost estimate", () => {
  const sessions = [{ id: "kestrel", topic: "Kestrel project", questions: [{ id: "q01" }, { id: "q07" }] }];
  const plan = planSessions(sessions, ["A"], 2, 1);
  const withCost = formatSessionPlan(plan, { avg: 0.02, samples: 10 });
  assert.match(withCost, /2 run\(s\) over 1 session\(s\), 4 question-turns total/);
  assert.match(withCost, /kestrel \(Kestrel project, 2 questions\) × 2 run\(s\)/);
  assert.match(withCost, /estimated cost ≈\$0\.080/);
  const withoutCost = formatSessionPlan(plan, null);
  assert.match(withoutCost, /cannot be estimated/);
});
