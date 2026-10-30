// @ts-check
// Import the spaces, tabs and agent sessions from herdr (the TUI) into Herdr.
// Everything happens in the window: this mod reads what herdr saved, asks the
// app to make the spaces, and resumes each agent in place. It never copies a
// session (two programs cannot append to one), so a workspace herdr is still
// running is refused until that tab is closed there.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, readTextFile, run, spaces, theme, props, closeOverlay } from "herdr";

const SESSIONS = ".config/herdr/session.json";

// How each agent reopens a conversation it left. Only the ones that can be
// resumed exactly are here; anything else opens as a shell and says why.
/** @type {Record<string, { flag: string, kind: string }>} */
const RESUME = {
  pi: { flag: "--session", kind: "path" },
  "claude-code": { flag: "--resume", kind: "id" },
  claude: { flag: "--resume", kind: "id" },
};

export default class ImportFromHerdr extends View {
  init(_props, cx) {
    this.spaces = null;
    this.live = new Set();
    this.picked = new Set();
    this.here = new Set(); // folders already in Herdr
    this.busy = false;
    this.log = null;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn((cx) => this.load(cx));
  }

  async load(cx) {
    this.error = null;
    this.log = null;
    this.here = new Set((spaces() ?? []).map((s) => s.folder));

    let doc = null;
    try {
      doc = JSON.parse(await readTextFile(`${home()}/${SESSIONS}`));
    } catch {
      this.error = `Nothing saved in ${SESSIONS}. herdr has not run on this machine, or it has no workspaces yet.`;
      cx.notify();
      return;
    }

    this.spaces = (doc.workspaces ?? []).map((ws, i) => {
      const panes = ws.tabs.flatMap((tab) => Object.values(tab.panes ?? {}));
      const agents = panes.filter((p) => p.agent_session?.value);
      return {
        id: ws.id,
        name: ws.custom_name || "",
        folder: ws.identity_cwd || panes[0]?.cwd || "",
        tabs: ws.tabs.map((tab, j) => ({
          name: tab.custom_name || "",
          folder: Object.values(tab.panes ?? {})[0]?.cwd || "",
          argv: this.argv(Object.values(tab.panes ?? {})[0]),
          index: j,
        })),
        agents: agents.length,
        sessions: agents.map((p) => p.agent_session.value),
      };
    });

    this.live = await this.runningSessions();
    this.picked = new Set(this.spaces.filter((s) => this.ready(s)).map((s) => s.id));
    cx.notify();
  }

  argv(pane) {
    const session = pane?.agent_session;
    /** @type {{ flag: string, kind: string } | undefined} */
    const recipe = RESUME[session?.agent];
    if (!recipe || session.kind !== recipe.kind || !session.value) return null;
    return [session.agent, recipe.flag, session.value];
  }

  // herdr answers only while it runs, which is exactly when its sessions must
  // be left alone. A stopped TUI cannot answer, and that is the safe moment.
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
    return this.running(space) === 0 && !this.here.has(space.folder);
  }

  state(space) {
    if (this.here.has(space.folder)) return "already in Herdr";
    const running = this.running(space);
    if (running) return `${running} running in herdr`;
    return null;
  }

  toggle(id, cx) {
    const space = this.spaces.find((s) => s.id === id);
    if (!space || !this.ready(space) || this.busy) return;
    this.picked.has(id) ? this.picked.delete(id) : this.picked.add(id);
    cx.notify();
  }

  // No ids come back from `run`, and a new space becomes the active one, so a
  // tab asked for right after a space lands in it. The queue keeps that order.
  async bring(space) {
    const [first, ...rest] = space.tabs;
    // The app rejects an argument it does not know the shape of, so empty ones
    // are left out rather than sent as null.
    const args = (all) => Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    run("space.new", args({ name: space.name, folder: space.folder, tab: first?.name, argv: first?.argv }));
    for (const tab of rest) {
      run("tab.new", args({ name: tab.name, folder: tab.folder, argv: tab.argv }));
    }
    return space.tabs.length;
  }

  async start(cx) {
    if (this.busy || !this.picked.size) return;
    this.busy = true;
    this.error = null;
    const chosen = this.spaces.filter((s) => this.picked.has(s.id));
    this.log = `Bringing over ${chosen.length}…`;
    cx.notify();

    let tabs = 0;
    for (const space of chosen) tabs += await this.bring(space);

    this.busy = false;
    this.log = `${chosen.length} space${chosen.length === 1 ? "" : "s"}, ${tabs} tab${tabs === 1 ? "" : "s"} — the agents resume what they left.`;
    this.picked = new Set();
    await this.load(cx);
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
    const blocked = this.spaces.filter((s) => this.running(s) > 0).length;

    return this.frame(
      t,
      v_flex()
        .gap(2)
        .child(this.heading(t, blocked))
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

  heading(t, blocked) {
    const line = blocked
      ? `${blocked} still run in herdr. Close those tabs there first: a session cannot be resumed in two places.`
      : "Each agent resumes the conversation it left. Nothing is copied.";
    return div().px(10).py(8).text_size(12.5).text_color(blocked ? (t.warn ?? t.muted) : t.muted).child(line);
  }

  row(t, space) {
    const picked = this.picked.has(space.id);
    const note = this.state(space);
    const blocked = !this.ready(space);
    const meta = [`${space.tabs.length} tab${space.tabs.length === 1 ? "" : "s"}`, space.agents ? `${space.agents} agent${space.agents === 1 ? "" : "s"}` : "no agents", note]
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
      .child(div().w(16).text_size(13).text_color(blocked ? t.dim : picked ? (t.accent ?? t.foreground) : t.dim).child(blocked ? "—" : picked ? "◉" : "◯"))
      .child(
        v_flex()
          .flex_1()
          .gap(2)
          .child(div().text_size(13).text_color(t.foreground).child(space.name || "(named after its folder)"))
          .child(div().text_size(11.5).text_color(t.dim).child(`${space.folder}  ·  ${meta}`)),
      );
  }

  footer(t, picked, blocked) {
    const can = picked > 0 && !this.busy;
    return h_flex()
      .gap(8)
      .items_center()
      .px(12)
      .py(10)
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.panel)
      .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.log ?? (blocked ? "Waiting for herdr to let go" : `${picked} selected`)))
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
          .bg(can ? (t.accent ?? t.solid) : t.raised)
          .text_color(can ? (t.accent_foreground ?? t.solid_foreground ?? t.foreground) : t.dim)
          .text_size(12)
          .font_medium()
          .when(can, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
          .on_click((_e, cx) => this.start(cx))
          .child(this.busy ? "Bringing over…" : `Import ${picked || ""}`.trim()),
      );
  }

  message(t, text, color) {
    return div().p(16).text_size(12.5).text_color(color).child(text);
  }
}
