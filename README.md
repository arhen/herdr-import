# herdr-import

Bring the spaces, tabs and agent sessions you built in **herdr** (the TUI) into
**Herdr**. One dialog in the window, one click: each agent resumes the
conversation it left, in place, and herdr is left exactly as it was.

No command line. The whole thing is one folder of JavaScript — a Herdr mod.

## Install

```sh
cp -R mod ~/.config/herdr-app/mods/herdr-import
```

Nothing else: no dependencies, no daemon, no binary. Herdr picks it up on save.

## Use

**Shift P** → `mod.open herdr-import` → tick the workspaces → **Import**.

The dialog lists every herdr workspace with its folder, tab count and agent
count. Rows that herdr is still running are marked and cannot be picked, with
the reason: a session cannot be resumed in two places. Close that tab in herdr
and the row frees up. Rows already in Herdr say so instead of making twins.

## What it does, and what it refuses

| herdr | becomes |
| --- | --- |
| workspace with a name | space of that name |
| workspace without one | space named after its folder |
| tab | tab, in the same order, same folder |
| pane with an agent | that agent, resumed: `pi --session <file>` |
| pane without one | a shell in the same folder |
| workspace already imported | left alone |

- **No copying, no forking.** A conversation is resumed from the file it lives
  in. Two programs appending to one session file corrupt it, so a session herdr
  still runs is refused, never duplicated.
- **herdr is never written to.** It is read and left alone; its own state keeps
  working if you go back.
- **Nothing is deleted.** Import only creates spaces.
- Works with herdr already closed: it then reads
  `~/.config/herdr/session.json`, which is what the TUI leaves behind. That is
  the safe moment — nothing is running, so everything can be resumed.

## Requirements

- Herdr (the app). `hc` is already part of it.
- The agent's own resume flag must exist. `pi`, `claude` and `codex` are known;
  an agent without an entry opens as a shell and the row says why.

## Files

```
mod/
  mod.json        the dialog this mod opens as
  main.js         the whole importer, ~260 lines
  jsconfig.json   what Herdr wrote beside the mod, kept as it is
```

**JavaScript, not TypeScript.** Every mod Herdr ships is `main.js` (21 of 21);
the only `.ts` files in its `defaults/mods` are build-time asset generators. The
app loads `main.js` from disk as-is and rewrites `gpui-kit.d.ts` and
`herdr.d.ts` beside it on every start, so saving a file reloads it in place. A
TypeScript mod would need a build step between save and reload, which is the
loop the whole mod system is built on.

You still get the typing: `// @ts-check` plus the generated declarations means
`npx -p typescript@5 tsc -p jsconfig.json` type-checks plain JS against the real
API. Herdr's own mods are not type-clean under it either — the shipped `agents`
mod reports 107 errors, this one 46 — so treat it as editor help, not a gate.
`herdr-app check mod` is the gate.

`herdr-app check mod` loads and renders it once without the window.

## Why this is a mod and not a Herdr feature

Upstream's `CONTRIBUTING.md`: *"If what you want can be done with a mod or a
layout, build it... Issues that ask for a custom mod, or for a feature a mod can
already do, get closed."* Importing is a mod, so it is one.

What a mod cannot do is install another mod, so Herdr has no `mod.install
owner/repo` the way herdr has `herdr plugin install`. Until it does, the folder
above is the installation.
