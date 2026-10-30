# herdr-import

Bring the spaces, tabs and agent sessions you set up in **herdr** (the TUI) into
**herdr-app** and **herdr-core** (`hc`, the GUI's background program).

herdr and herdr-app keep separate state and neither imports the other. This tool
reads herdr's live state and creates the same shape in herdr-app: one space per
workspace, one tab per tab, one terminal per pane, and each agent pane back with
its conversation.

## From the app, no terminal

The app's plugins are mods. Install this one once and the whole handover is
three clicks:

```sh
git clone https://github.com/arhen/herdr-import
ln -s "$PWD/herdr-import/bin/herdr-import.js" ~/.local/bin/herdr-import
ln -s "$PWD/herdr-import/mod" ~/.config/herdr-app/mods/herdr-import
```

Then in Herdr: **Shift P** (commands) → `mod.open herdr-import` → tick what
comes over → **Import**. A dialog lists every herdr workspace with its folder,
tab and agent count. Anything herdr still runs is marked and cannot be picked,
with the reason: one session cannot be resumed in two places. Close that tab in
herdr and the row frees up.

The mod calls the same script, so there is nothing to paste into a shell and no
terminal to keep open. It works with herdr already closed, reading the state
herdr left in `~/.config/herdr/session.json`.

## From a terminal

Two ways to use it, depending on what you want:

```sh
# 1. Move: import everything once, then live in herdr-app
herdr-import                              # the plan, nothing written
herdr-import --apply                      # create it in herdr-app
herdr-import --apply --machines           # also add herdr's machines to herdr-core

# 2. Both: keep using herdr, and keep herdr-app in step with it
herdr-import --watch
```

`--watch` listens to herdr's event stream (`events.subscribe`) and mirrors
new workspaces, new tabs and renames into herdr-app as they happen. Every event
only invalidates a cache: the tool re-reads `herdr api snapshot`, herdr's own
guidance for subscribers, and diffs it against the ledger. So a rename lands as
a rename, a new workspace as a new space, and a reconnected watcher picks up
whatever it missed.

What `--watch` deliberately does not do:

- **Never closes or kills anything.** A workspace that disappears from herdr only
  gets marked stale in the ledger. Your terminals in the app keep running.
- **No agent copies by default.** In watch mode a new tab opens as a shell, so
  watching does not spawn a second `pi` per workspace. Pass `--agents resume`
  to carry agents over, with the same fork rule as below.

## What it does and does not touch

- Reads herdr. Never writes to it, never stops it: herdr keeps running exactly
  as it was.
- Creates spaces in herdr-app. Nothing is merged, renamed or deleted.
- Re-running is safe. A ledger at `~/.local/state/herdr-import/ledger.json`
  remembers which herdr workspace became which space, so a second run skips
  what is already there. Use `--force` to import one again.
- Requires the Herdr window to be open: only the running window can create
  spaces. `hc server status` must be up too (`hc server start`).

## Agents carry over, even while they run

herdr panes that are running an agent are imported as that agent, with the
conversation:

| herdr pane | becomes |
| --- | --- |
| agent running now | `pi --fork <session file>`: a **copy** of the conversation |
| agent finished | `pi --session <session file>`: the same conversation |
| no agent | a shell in the same folder |

Forking matters. Two programs appending to one session file corrupt it, so a
pane that resumes a session herdr is *still running* would be a bug. `--fork`
gives the new pane the history and its own file. Pass `--include-live` to
resume the shared file anyway; the plan says so loudly when you do.

Resume flags come from a small table (`pi`, `claude`, `codex`). An agent with no
entry opens as a shell and the plan says why.

## Options

```
--in <file>        read a snapshot from a file instead of asking herdr
--apply            create them; without this nothing is written
--agents <mode>    resume (default) | shell | skip
--machines         hc machine add for machines herdr has and herdr-core does not
--only <ids>       comma list of herdr workspace ids, e.g. wK,wT
--force            re-import workspaces the ledger says are done
--include-live     let a pane resume a session herdr is running right now
--json             print the plan or the result as JSON
```

Exit codes: `0` done, `1` something failed (the rest still ran), `2` it could not
start (no Herdr window, no core, bad snapshot).

## Requirements

- `herdr` and `herdr-app` on `PATH`, herdr TUI running (state comes from
  `herdr api snapshot`), Herdr window open for `--apply`.
- Node 18 or newer. No dependencies.

## How it maps

| herdr | herdr-app |
| --- | --- |
| workspace (custom name) | space of that name |
| workspace (no name) | space named after its folder |
| tab | tab, in the same position |
| tab with no name | left unnamed, as in herdr |
| pane | terminal in that tab, same working directory |
| pane with an agent | that agent, resumed or forked |
| saved machine | `hc machine add <user@host> --name <label>` |

Tabs with more than one pane are split to the right, one after another: the
pane tree is flattened, because herdr's nested splits have no exact equivalent
in the app's command set.

## Why not a herdr-core feature

herdr-core runs terminals; it does not own spaces or tabs, so an importer does
not belong there. herdr-app owns them, which is where this belongs long term:

- `herdr api snapshot` already exposes everything needed, so nothing has to be
  added to herdr.
- herdr-app's welcome currently says "Your herdr workspaces stay where they
  are; nothing moves over" (`defaults/frame/welcome/main.js`). Flipping that to
  offer an import is the upstream change this tool argues for.
- The same logic works as a herdr-app mod, which is how it can ship to people
  who do not run Node scripts.
