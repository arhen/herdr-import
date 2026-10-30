#!/usr/bin/env node
// Imports herdr (TUI) state into herdr-app + herdr-core. One way, one shot,
// idempotent through a ledger. Never touches the source: herdr keeps running.

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AGENTS = {
  pi: { flag: "--session", fork: "--fork", kind: "path" },
  "claude-code": { flag: "--resume", fork: "--fork-session", kind: "id" },
  claude: { flag: "--resume", fork: "--fork-session", kind: "id" },
  codex: { resume: "resume", kind: "id" },
};

const USAGE = `herdr-import — bring herdr's spaces, tabs and agents into herdr-app

Usage
  herdr-import                    show what would be imported (dry run)
  herdr-import --apply            create the spaces, tabs and agents
  herdr-import --apply --machines also add herdr's machines to herdr-core

Options
  --in <file>        Read a snapshot from a file instead of running herdr
  --apply            Create them. Without this nothing is written.
  --agents <mode>    resume (default) | shell | skip
  --machines         Run hc machine add for machines herdr knows and hc does not
  --only <ids>       Comma list of herdr workspace ids, e.g. wK,wT
  --force            Re-import workspaces the ledger says are done
  --include-live     Let a new pane resume a session herdr is running right now:
                     two programs writing one session file. Opt in knowingly.
  --watch            Keep herdr-app in step with herdr while you use both:
                     new workspaces, tabs and renames are mirrored as they happen.
                     Nothing is ever closed or killed. Ctrl+C stops watching.
  --json             Print the plan or the result as JSON
  -h, --help         This text

Nothing is merged or deleted: import only creates spaces. Run it again after
closing those spaces, or on another machine, as often as you like.`;

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return out(USAGE), 0;

  const snapshot = opts.in ? readSnapshot(opts.in) : liveSnapshot();
  const plan = buildPlan(snapshot, opts);
  if (!plan.spaces.length && !plan.machines.length) {
    out(opts.json ? JSON.stringify({ spaces: [], machines: [] }, null, 2) : "Nothing to import: herdr has no workspaces or machines this tool has not seen.");
    return 0;
  }
  if (opts.watch) return watch(opts);
  if (!opts.apply) {
    opts.json ? out(JSON.stringify(plan, null, 2)) : printPlan(plan);
    return 0;
  }
  return apply(plan, opts);
}

// ---- arguments and sources

function parseArgs(argv) {
  const opts = { apply: false, agents: "resume", machines: false, force: false, json: false, help: false, in: null, only: null, includeLive: false, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") opts.apply = true;
    else if (a === "--machines") opts.machines = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--include-live") opts.includeLive = true;
    else if (a === "--watch") opts.watch = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--in") opts.in = next();
    else if (a === "--only") opts.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--agents") {
      opts.agents = next();
      opts.agentsGiven = true;
    }
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  if (!["resume", "shell", "skip"].includes(opts.agents)) throw new Error(`--agents is resume, shell or skip, not ${opts.agents}`);
  return opts;
}

function liveSnapshot() {
  const r = run("herdr", ["api", "snapshot"]);
  if (r.code !== 0) throw new Error(`herdr api snapshot failed: ${(r.stderr || r.stdout).trim()}`);
  return unwrap(JSON.parse(r.stdout));
}

function readSnapshot(file) {
  return unwrap(JSON.parse(readFileSync(file, "utf8")));
}

function unwrap(doc) {
  const snap = doc?.result?.snapshot ?? doc?.snapshot ?? doc;
  if (!snap?.workspaces || !snap?.tabs || !snap?.panes) throw new Error("that is not a herdr snapshot: workspaces, tabs and panes are missing");
  return snap;
}

// ---- plan

function buildPlan(snap, opts) {
  const ledger = readLedger();
  const panesByTab = groupBy(snap.panes, (p) => p.tab_id);
  const tabsBySpace = groupBy(snap.tabs, (t) => t.workspace_id);
  const spaces = [];

  for (const ws of [...snap.workspaces].sort((a, b) => a.number - b.number)) {
    if (opts.only && !opts.only.includes(ws.workspace_id)) continue;
    if (ledger.spaces[ws.workspace_id] && !opts.force) continue;

    const tabs = (tabsBySpace[ws.workspace_id] ?? [])
      .sort((a, b) => a.number - b.number)
      .map((tab) => {
        const panes = (panesByTab[tab.tab_id] ?? [])
          .sort((a, b) => Number(b.focused) - Number(a.focused) || a.pane_id.localeCompare(b.pane_id))
          .map((pane) => panePlan(pane, opts));
        return { sourceId: tab.tab_id, name: ownName(tab.label, null), folder: panes[0]?.cwd || "", panes };
      })
      .filter((tab) => tab.panes.length);

    if (!tabs.length) continue;
    spaces.push({ sourceId: ws.workspace_id, name: ownName(ws.label, tabs[0].folder), folder: tabs[0].folder, tabs });
  }

  const machine = opts.machines ? machinesToAdd() : [];
  return { importedFrom: "herdr", spaces, machines: machine, dryRun: !opts.apply, liveSkipped: countLive(spaces) };
}

function countLive(spaces) {
  return spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).filter((p) => p.live).length;
}

/// herdr labels unnamed tabs with their number and unnamed workspaces with
/// their folder's name. Passing those back would freeze a copy, so drop them
/// and let herdr-app derive its own.
function ownName(label, folder) {
  const name = (label ?? "").trim();
  if (!name || /^\d+$/.test(name)) return "";
  if (folder && name === basename(folder)) return "";
  return name;
}

function basename(path) {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

function panePlan(pane, opts) {
  const cwd = pane.cwd || pane.foreground_cwd || "";
  const live = Boolean(pane.agent_status);
  const session = pane.agent_session;
  const recipe = AGENTS[pane.agent];
  const plan = { sourceId: pane.pane_id, cwd, argv: null, agent: pane.agent || null, live, note: null };
  if (!pane.agent || opts.agents === "skip") return plan;
  if (opts.agents === "shell") {
    plan.note = `${pane.agent} session not resumed (--agents shell)`;
    return plan;
  }
  if (!recipe) {
    plan.note = `${pane.agent} has no resume recipe here: opened as a shell`;
    return plan;
  }
  if (!session?.value || session.kind !== recipe.kind) {
    plan.note = `${pane.agent} session is a ${session?.kind ?? "missing"} not a ${recipe.kind}: opened as a shell`;
    return plan;
  }
  if (recipe.kind === "path" && !existsSync(session.value)) {
    plan.note = `session file is gone: ${session.value}`;
    return plan;
  }
  if (live && !opts.includeLive) {
    if (!recipe.fork) {
      plan.note = `${pane.agent} is live in herdr now and has no fork flag here: opened as a shell`;
      return plan;
    }
    plan.argv = [pane.agent, recipe.fork, session.value];
    plan.note = "forked: herdr keeps the original, this pane gets its own copy";
    return plan;
  }
  plan.argv = recipe.resume ? [pane.agent, recipe.resume, session.value] : [pane.agent, recipe.flag, session.value];
  if (live) plan.note = "herdr runs this session too (--include-live): two programs write one file";
  return plan;
}

function machinesToAdd() {
  const listed = run("herdr", ["machine", "list"]);
  if (listed.code !== 0) return [];
  const have = new Set(
    (() => {
      const r = run("hc", ["machine", "ls", "--json"]);
      if (r.code !== 0) return [];
      try {
        return (JSON.parse(r.stdout).machines ?? []).map((m) => m.name);
      } catch {
        return [];
      }
    })(),
  );
  const add = [];
  for (const line of listed.stdout.split("\n")) {
    const [id, name, target, , state] = line.trim().split("\t");
    if (!id || !name || !target || state !== "enabled" || have.has(name)) continue;
    add.push({ sourceId: id, name, target: sshTarget(target) });
  }
  return add;
}

function sshTarget(raw) {
  const stripped = raw.replace(/^ssh:\/\//, "");
  const [userHost, port] = stripped.split(":");
  if (port) return { target: userHost, warn: `port ${port}: hc reads the port from ~/.ssh/config, so a Host entry is needed` };
  return { target: userHost, warn: null };
}

// ---- apply

function apply(plan, opts) {
  preflight();

  const results = { spaces: [], machines: [], errors: [] };

  for (const m of plan.machines) {
    const args = ["machine", "add", m.target.target, "--name", m.name, "--install"];
    const r = run("hc", args);
    if (r.code === 0) {
      results.machines.push({ name: m.name, target: m.target.target });
    } else {
      results.errors.push({ what: `machine ${m.name}`, why: (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" "), how: `hc ${args.join(" ")}` });
    }
  }

  const ledger = readLedger();
  adoptExisting(ledger);

  for (const space of plan.spaces) {
    // A space this workspace already has: keep it, only add the tabs it lacks.
    const entry = ledger.spaces[space.sourceId];
    if (entry && !opts.force) {
      const filled = fillTabs(space, entry, results.errors);
      results.spaces.push({ sourceId: space.sourceId, name: space.name, space: entry.space, tabs: entry.tabs, adopted: true, filled });
      continue;
    }
    const created = createSpace(space, results.errors);
    if (!created) continue;
    ledger.spaces[space.sourceId] = { space: created.space, name: space.name, tabs: created.tabs, at: new Date().toISOString() };
    results.spaces.push({ sourceId: space.sourceId, name: space.name, ...created });
    writeLedger(ledger);
  }

  if (opts.json) out(JSON.stringify(results, null, 2));
  else printResult(results);
  return results.errors.length ? 1 : 0;
}

function createSpace(space, errors) {
  const first = space.tabs[0];
  const made = appDo("space.new", { name: space.name, folder: space.folder, tab: first.name, argv: first.panes[0].argv });
  if (made.error) {
    errors.push({ what: `space ${space.name || space.folder}`, why: made.error });
    return null;
  }
  const tabs = { [first.sourceId]: made.tab };
  splitRest(first.panes, made.tab, errors, `space ${space.name || space.folder}`);

  for (const tab of space.tabs.slice(1)) {
    const t = appDo("tab.new", { space: made.space, name: tab.name, folder: tab.folder, argv: tab.panes[0].argv });
    if (t.error) {
      errors.push({ what: `tab ${tab.name || tab.folder}`, why: t.error });
      continue;
    }
    tabs[tab.sourceId] = t.tab;
    splitRest(tab.panes, t.tab, errors, `tab ${tab.name || tab.folder}`);
  }

  return { space: made.space, tabs };
}

// space.new and tab.new answer with the space, tab and terminal, not the pane a
// split needs, so a tab with more than one pane asks the window where it landed.
function splitRest(panes, tabId, errors, what) {
  for (const pane of panes.slice(1)) {
    const target = paneIdFor(tabId);
    if (!target) {
      errors.push({ what: `extra pane in ${what}`, why: `no pane found for tab ${tabId}` });
      continue;
    }
    const result = appDo("pane.split", { pane: target, direction: "right", argv: pane.argv });
    if (result.error) errors.push({ what: `extra pane in ${what}`, why: result.error });
  }
}

function paneIdFor(tabId) {
  const r = run("herdr-app", ["ls"]);
  if (r.code !== 0) return null;
  try {
    const world = JSON.parse(r.stdout);
    for (const space of world.spaces ?? []) {
      const tab = (space.tabs ?? []).find((t) => t.id === tabId);
      const pane = tab?.terminals?.find((t) => t.pane)?.pane;
      if (pane) return pane;
    }
    return null;
  } catch {
    return null;
  }
}

function appDo(command, args) {
  const payload = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const r = run("herdr-app", ["do", command, JSON.stringify(payload)]);
  const text = (r.stdout || r.stderr).trim();
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    try {
      reply = JSON.parse(text.split("\n").pop());
    } catch {
      return { error: text || `herdr-app exited ${r.code}` };
    }
  }
  if (reply.error) return { error: reply.error };
  if (r.code !== 0) return { error: text };
  return reply;
}

function preflight() {
  const status = run("herdr-app", ["status"]);
  if (status.code !== 0) {
    throw new Error(
      "the Herdr window is not running. Open Herdr first: spaces can only be created by the running window.\n" +
        (status.stderr || status.stdout).trim(),
    );
  }
  const hc = run("hc", ["server", "status"]);
  if (hc.code !== 0) throw new Error(`herdr-core is not running: ${(hc.stderr || hc.stdout).trim()}\nStart it with: hc server start`);
}

// ---- watch: keep both windows, herdr stays the source of truth
//
// Realtime events are used as invalidation signals only. Every event triggers
// an authoritative session.snapshot read (herdr's own guidance), and the diff
// against the ledger decides what to create. Nothing is ever closed: a space
// whose workspace went away is only marked stale, so terminals survive.

function watch(opts) {
  const sock = process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
  // Watching means the two windows run side by side, so a new TUI workspace must
  // not silently spawn a second copy of its agent: shells unless asked for more.
  const mode = opts.agentsGiven ? opts.agents : "shell";
  const subjects = mode === "shell" ? "shells, no agent copies" : mode === "skip" ? "no terminals' programs" : "agents carried over";
  out(`watching herdr → herdr-app (${subjects}). Nothing is closed by this tool. Ctrl+C to stop.`);

  let timer = null;
  let running = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(reconcile, 150);
  };

  function reconcile() {
    if (running) return schedule();
    running = true;
    try {
      const plan = buildPlan(liveSnapshot(), { ...opts, agents: mode, apply: true, only: null });
      const created = [];
      const errors = [];
      for (const space of plan.spaces) {
        const made = createSpace(space, errors);
        if (!made) continue;
        const ledger = readLedger();
        ledger.spaces[space.sourceId] = { space: made.space, name: space.name, tabs: made.tabs, at: new Date().toISOString(), watch: true };
        writeLedger(ledger);
        created.push(space.name || space.folder);
      }
      renameChanged();
      if (created.length) out(`mirrored ${created.length}: ${created.join(", ")}`);
      if (errors.length) out(`cannot mirror yet: ${errors[0].why}`);
    } catch (error) {
      out(`waiting: ${error.message.split("\n")[0]}`);
    } finally {
      running = false;
    }
  }

  // A rename in herdr becomes a rename in the app, matched through the ledger.
  function renameChanged() {
    const snap = liveSnapshot();
    const ledger = readLedger();
    let touched = false;
    for (const ws of snap.workspaces) {
      const entry = ledger.spaces[ws.workspace_id];
      if (!entry) continue;
      const name = ownName(ws.label, null);
      if (name && name !== entry.name) {
        const r = appDo("space.rename", { id: entry.space, name });
        if (!r.error) {
          entry.name = name;
          touched = true;
        }
      }
    }
    if (touched) writeLedger(ledger);
  }

  function connect() {
    const socket = createConnection(sock);
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id: "herdr-import-watch",
        method: "events.subscribe",
        params: { subscriptions: [
          { type: "workspace.created" }, { type: "workspace.closed" }, { type: "workspace.renamed" },
          { type: "workspace.moved" }, { type: "workspace.reordered" },
          { type: "tab.created" }, { type: "tab.closed" }, { type: "tab.renamed" },
          { type: "pane.created" }, { type: "pane.closed" },
        ] },
      })}\n`);
      reconcile();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error?.code === "events_lost") {
          out("event history was lost: reading herdr again");
          socket.destroy();
          return;
        }
        if (message.result?.type === "subscription_started") {
          out("connected: listening for changes");
          continue;
        }
        if (message.method || message.event) schedule();
      }
    });
    socket.on("close", () => setTimeout(connect, 2000));
    socket.on("error", () => socket.destroy());
  }

  connect();
  return new Promise(() => {});
}

// ---- reconciling with what the app already has

function appWorld() {
  const r = run("herdr-app", ["ls"]);
  if (r.code !== 0) return { spaces: [] };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { spaces: [] };
  }
}

/// Records herdr workspaces whose space already exists in the app, matched by
/// name and folder, so a second run adopts them instead of making twins.
function adoptExisting(ledger) {
  const world = appWorld();
  const adopted = [];
  const taken = new Set(Object.values(ledger.spaces).map((e) => e.space));
  let changed = false;

  for (const space of pendingWorkspaces(ledger)) {
    const match = (world.spaces ?? []).find(
      (s) => !taken.has(s.id) && (space.name ? s.name === space.name : (!s.name || s.name === basename(s.folder ?? ""))) && sameFolder(s.folder, space.folder),
    );
    if (!match) continue;
    ledger.spaces[space.sourceId] = { space: match.id, name: match.name, tabs: {}, at: new Date().toISOString(), adopted: true };
    taken.add(match.id);
    changed = true;
    adopted.push(space);
  }

  if (changed) writeLedger(ledger);
  return adopted;
}

function sameFolder(a, b) {
  return (a ?? "").replace(/\/+$/, "") === (b ?? "").replace(/\/+$/, "");
}

function pendingWorkspaces(ledger) {
  try {
    return buildPlan(liveSnapshot(), { agents: "shell", only: null }).spaces.filter((s) => !ledger.spaces[s.sourceId]);
  } catch {
    return [];
  }
}

/// Creates the tabs a herdr workspace has and the app's space does not, in
/// order. Names are the key; unnamed tabs are matched by position.
function fillTabs(space, entry, errors) {
  const world = appWorld();
  const shown = (world.spaces ?? []).find((s) => s.id === entry.space);
  if (!shown) return 0;
  const have = shown.tabs ?? [];
  const usedNames = new Set(have.map((t) => t.name).filter((n) => n && ownName(n, null)));
  let unnamed = have.filter((t) => !ownName(t.name, null)).length;
  let made = 0;

  for (const tab of space.tabs) {
    const named = Boolean(tab.name);
    if (named ? usedNames.has(tab.name) : unnamed > 0) {
      if (!named) unnamed -= 1;
      continue;
    }
    const t = appDo("tab.new", { space: entry.space, name: tab.name, folder: tab.folder, argv: tab.panes[0].argv });
    if (t.error) {
      errors.push({ what: `tab ${tab.name || tab.folder}`, why: t.error });
      continue;
    }
    entry.tabs[tab.sourceId] = t.tab;
    if (named) usedNames.add(tab.name);
    made += 1;
  }

  if (made) writeLedger(readLedgerMerge(entry));
  return made;
}

function readLedgerMerge(entry) {
  const ledger = readLedger();
  const found = Object.entries(ledger.spaces).find(([, e]) => e.space === entry.space);
  if (found) ledger.spaces[found[0]] = entry;
  return ledger;
}

// ---- ledger

function ledgerPath() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "herdr-import", "ledger.json");
}

function readLedger() {
  try {
    const doc = JSON.parse(readFileSync(ledgerPath(), "utf8"));
    return { version: 1, spaces: doc.spaces ?? {} };
  } catch {
    return { version: 1, spaces: {} };
  }
}

function writeLedger(ledger) {
  const file = ledgerPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

// ---- output

function printPlan(plan) {
  const lines = [];
  const agents = plan.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).filter((p) => p.argv).length;
  const panes = plan.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).length;
  const tabs = plan.spaces.flatMap((s) => s.tabs).length;
  lines.push(`herdr → herdr-app: ${plan.spaces.length} spaces, ${tabs} tabs, ${panes} terminals, ${agents} agents carried over`);
  if (plan.liveSkipped) {
    lines.push(`  ${plan.liveSkipped} of them are still running in herdr: they are forked, so the conversation carries over into a copy`);
  }
  lines.push("");
  for (const s of plan.spaces) {
    lines.push(`  ${s.name || "(named after its folder)"}   ${s.folder}`);
    for (const t of s.tabs) {
      lines.push(`    tab ${t.name || "(number)"}   ${t.folder}`);
      for (const p of t.panes) {
        const what = p.argv ? `${p.argv.join(" ")}` : "shell";
        lines.push(`      ${what}${p.note ? `   [${p.note}]` : ""}`);
      }
    }
  }
  if (plan.machines.length) {
    lines.push("");
    lines.push(`machines to add to herdr-core (hc machine add): ${plan.machines.length}`);
    for (const m of plan.machines) lines.push(`  ${m.name}   ${m.target.target}${m.target.warn ? `   [${m.target.warn}]` : ""}`);
  }
  lines.push("");
  lines.push("Nothing written. Run with --apply to create them.");
  out(lines.join("\n"));
}

function printResult(results) {
  const lines = [];
  for (const s of results.spaces) {
    const tabs = Object.keys(s.tabs ?? {}).length;
    lines.push(s.adopted ? `already there: space ${s.name || s.space} (${s.space}), added ${s.filled ?? 0} tab(s)` : `created space ${s.name || s.space} (${s.space}) with ${tabs} tab(s)`);
  }
  for (const m of results.machines) lines.push(`added machine ${m.name} (${m.target})`);
  for (const e of results.errors) {
    lines.push(`failed: ${e.what}: ${e.why}`);
    if (e.how) lines.push(`  run it yourself in a terminal: ${e.how}`);
  }
  out(lines.join("\n") || "nothing to do");
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

// ---- helpers

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: process.env, timeout: 120_000 });
  if (r.error) return { code: 127, stdout: "", stderr: `${cmd}: ${r.error.message}` };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function groupBy(items, key) {
  const map = {};
  for (const item of items) {
    const k = key(item);
    (map[k] ??= []).push(item);
  }
  return map;
}

try {
  const result = main(process.argv.slice(2));
  if (result && typeof result.then === "function") await result;
  else process.exitCode = result;
} catch (error) {
  process.stderr.write(`herdr-import: ${error.message}\n`);
  process.exitCode = 2;
}
