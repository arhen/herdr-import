// Import the spaces, tabs and agent sessions from herdr (the TUI) into Herdr.
// One list, one button: pick what comes over, and each agent resumes the
// conversation it left. Nothing is copied: a session that herdr still runs is
// refused until that tab is closed, because two programs cannot share it.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, readTextFile, theme, props, closeOverlay } from "herdr";

const SESSIONS = ".config/herdr/session.json";
// The importer is a plain script; `herdr-import` on PATH is the normal install.
const CANDIDATES = ["herdr-import", `${home()}/.local/bin/herdr-import`, `${home()}/Code/personal/herdr-import/bin/herdr-import.js`];

export default class ImportFromHerdr extends View {
  init(_props, cx) {
    this.spaces = null; // herdr workspaces, as the file describes them
    this.live = new Set(); // session files herdr is running right now
    this.picked = new Set(); // workspace ids to bring over
    this.busy = false;
    this.log = null;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn((cx) => this.load(cx));
  }

  async load(cx) {
    this.error = null;
    const path = `${home()}/${SESSIONS}`;
    let doc = null;
    try {
      doc = JSON.parse(await readTextFile(path));
    } catch {
      this.error = `No ${SESSIONS}: herdr has never run on this machine, or it has nothing saved yet.`;
      cx.notify();
      return;
    }

    this.spaces = (doc.workspaces ?? []).map((ws, i) => {
      const panes = ws.tabs.flatMap((t) => Object.values(t.panes ?? {}));
      const agents = panes.filter((p) => p.agent_session?.value);
      return {
        id: ws.id,
        number: i + 1,
        name: ws.custom_name || "",
        folder: ws.identity_cwd || panes[0]?.cwd || "",
        tabs: ws.tabs.length,
        agents: agents.length,
        sessions: agents.map((p) => p.agent_session.value),
      };
    });

    this.live = await this.runningSessions();
    this.picked = new Set(this.spaces.filter((s) => this.ready(s)).map((s) => s.id));
    cx.notify();
  }

  // herdr answers only while it runs; that is exactly when we must not take its
  // sessions. A stopped TUI is the safe moment, and then it cannot answer.
  async runningSessions() {
    const r = await exec("herdr", ["api", "snapshot"]).catch(() => null);
    if (r?.code !== 0) return new Set();
    try {
      const snap = JSON.parse(r.stdout).result?.snapshot;
      return new Set((snap?.panes ?? []).filter((p) => p.agent_status).map((p) => p.agent_session?.value).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  running(space) {
    return space.sessions.filter((s) => this.live.has(s)).length;
  }

  ready(space) {
    return this.running(space) === 0;
  }

  toggle(id, cx) {
    const space = this.spaces.find((s) => s.id === id);
    if (!space || !this.ready(space) || this.busy) return;
    this.picked.has(id) ? this.picked.delete(id) : this.picked.add(id);
    cx.notify();
  }

  async run(cx) {
    if (this.busy || !this.picked.size) return;
    this.busy = true;
    this.log = "Bringing them over…";
    this.error = null;
    cx.notify();

    const args = ["--in", `${home()}/${SESSIONS}`, "--apply", "--only", [...this.picked].join(",")];
    let r = null;
    for (const candidate of CANDIDATES) {
      r = await exec(candidate, args, { cwd: home() }).catch(() => null);
      if (r && r.code !== 127) break;
    }
    if (!r || r.code === 127) {
      this.busy = false;
      this.error = "herdr-import is not installed. Put the script on your PATH (~/.local/bin/herdr-import) and open this again.";
      cx.notify();
      return;
    }

    this.busy = false;
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (r.code === 0) {
      this.log = text || "Imported.";
      this.picked = new Set();
      await this.load(cx);
    } else {
      this.log = null;
      this.error = text || `herdr-import exited ${r.code}`;
    }
    cx.notify();
  }

  close() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") {
      this.close();
      cx.stop_propagation();
    }
  }

  render() {
    const t = theme();
    if (this.error) return this.frame(t, this.message(t, this.error, t.warn ?? t.muted));
    if (!this.spaces) return this.frame(t, this.message(t, "Reading what herdr saved…", t.muted));
    if (!this.spaces.length) return this.frame(t, this.message(t, "herdr has no workspaces saved. Nothing to bring over.", t.muted));

    const picked = this.spaces.filter((s) => this.picked.has(s.id)).length;
    const blocked = this.spaces.filter((s) => !this.ready(s)).length;

    return this.frame(
      t,
      v_flex()
        .gap(2)
        .child(this.heading(t, this.spaces.length, blocked))
        .children(this.spaces.map((s) => this.row(t, s))),
      this.footer(t, picked, blocked),
    );
  }

  frame(t, body, footer) {
    return v_flex()
      .size_full()
      .bg(t.panel ?? t.background)
      .child(v_flex().flex_1().overflow_hidden().gap(2).p(6).child(body))
      .when(Boolean(footer), (el) => el.child(footer));
  }

  heading(t, total, blocked) {
    const line = blocked
      ? `${blocked} of ${total} still run in herdr. Close those tabs first: a session cannot be resumed in two places.`
      : `${total} workspaces. Each agent resumes the conversation it left.`;
    return div().px(10).py(8).text_size(12.5).text_color(blocked ? (t.warn ?? t.muted) : t.muted).child(line);
  }

  row(t, space) {
    const picked = this.picked.has(space.id);
    const blocked = !this.ready(space);
    const running = this.running(space);
    const meta = [
      `${space.tabs} tab${space.tabs === 1 ? "" : "s"}`,
      space.agents ? `${space.agents} agent${space.agents === 1 ? "" : "s"}` : "no agents",
      blocked ? `${running} running in herdr` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return h_flex()
      .id(`hi-${space.id}`)
      .gap(10)
      .items_center()
      .px(10)
      .py(9)
      .rounded(8)
      .when(!blocked && !this.busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.toggle(space.id, cx))
      .child(
        div()
          .w(16)
          .text_size(13)
          .text_color(blocked ? t.dim : picked ? (t.accent ?? t.foreground) : t.dim)
          .child(blocked ? "—" : picked ? "◉" : "◯"),
      )
      .child(
        v_flex()
          .flex_1()
          .gap(2)
          .child(div().text_size(13).text_color(t.foreground).child(space.name || "(named after its folder)"))
          .child(div().text_size(11.5).text_color(t.dim).child(`${space.folder}  ·  ${meta}`)),
      );
  }

  footer(t, picked, blocked) {
    return h_flex()
      .gap(8)
      .items_center()
      .px(12)
      .py(10)
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.panel)
      .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.log ?? (blocked ? "Waiting on herdr to let go" : `${picked} selected`)))
      .child(
        div()
          .id("hi-cancel")
          .px(12)
          .h(28)
          .flex()
          .items_center()
          .rounded(7)
          .text_size(12)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.close())
          .child("Close"),
      )
      .child(
        div()
          .id("hi-import")
          .px(14)
          .h(28)
          .flex()
          .items_center()
          .rounded(7)
          .bg(picked && !this.busy ? (t.accent ?? t.solid) : t.raised)
          .text_color(picked && !this.busy ? (t.accent_foreground ?? t.solid_foreground ?? t.foreground) : t.dim)
          .text_size(12)
          .font_medium()
          .when(picked && !this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
          .on_click((_e, cx) => this.run(cx))
          .child(this.busy ? "Importing…" : `Import ${picked || ""}`.trim()),
      );
  }

  message(t, text, color) {
    return div().p(16).text_size(12.5).text_color(color).child(text);
  }
}
