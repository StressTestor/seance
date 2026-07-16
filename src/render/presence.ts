// The presence: a living occult orb with an LED-emoticon face, redesign v3.
// One PresenceView instance drives every registered orb (the Overview hero,
// the header mini) plus the full-window event vignette. It idles on the
// breathe/flicker loop with a periodic blink, and reacts to events with the
// loudest applicable animation — bypass outranks deny outranks pass.
//
// Untrusted text (the roast) only ever reaches the DOM via textContent on a
// retained node. Everything else written here is a trusted literal or a
// computed style (theme colors, animation strings, sizes) — never innerHTML.

import "./presence.css";

import { el, setStyles } from "./dom";
import { EMBER, HEX, SPECTRAL, TOXIC, VIOLET, verdictColor } from "./theme";
import type { FlatEvent } from "../model/view";

/** The idle animation pair; restored on every orb after a one-shot event. */
const ORB_BASE =
  "presence-breathe 4.2s ease-in-out infinite, presence-flicker 7s steps(1,end) infinite";

type FaceKind = "idle" | "deny" | "pass" | "alarm" | "blink" | "happy";

/** LED faces — glyphs + state color, set via textContent/style (trusted). */
const FACES: Record<FaceKind, { t: string; c: string }> = {
  idle: { t: "◉ ◉", c: VIOLET },
  deny: { t: ">:[", c: EMBER },
  pass: { t: "¬‿¬", c: SPECTRAL },
  alarm: { t: "X X", c: TOXIC },
  blink: { t: "− −", c: VIOLET },
  happy: { t: "^ ^", c: HEX },
};

// Motion timing (ms) — matches the reference implementation exactly.
const BLINK_EVERY = 4200; // idle blink cadence
const BLINK_HOLD = 160; // how long the − − blink shows
const ORB_RESTORE = 950; // restore ORB_BASE after a one-shot flare/alarm
const RIPPLE_CLEAR = 560; // hide the pass ripple after its 520ms run
const FACE_LOCK = 1500; // pass/deny face hold
const FACE_LOCK_ALARM = 2400; // bypass face holds longer
const FACE_LOCK_HAPPY = 1100; // easter-egg face hold
const TYPE_MS = 26; // roast typing cadence per tick

// Reference geometry: face glyph is 30px on the 216px hero, 8px on the 30px
// mini; other sizes scale proportionally from those anchors.
const HERO_REF = 216;
const HERO_FACE_REF = 30;
const MINI_REF = 30;
const MINI_FACE_REF = 8;

export class PresenceView {
  private orbs: HTMLElement[] = [];
  private faces: HTMLElement[] = [];
  private ripples: HTMLElement[] = [];
  private vignette: HTMLElement | null = null;
  private lastLine: HTMLElement | null = null;
  private roastNode: HTMLElement | null = null;

  private faceLocked = false;
  private faceTimer = 0;
  private typeTimer = 0;

  constructor() {
    // Idle blink: − − for 160ms every 4.2s, suppressed while an event face
    // holds the lock. App-lifetime interval; the view is a singleton.
    window.setInterval(() => {
      if (this.faceLocked) return;
      this.setFace("blink");
      window.setTimeout(() => {
        if (!this.faceLocked) this.setFace("idle");
      }, BLINK_HOLD);
    }, BLINK_EVERY);
  }

  /** The big hero orb assembly + label + LAST line + typed roast, for the
   * Overview tab. Registers the orb/face/ripple so react() animates them. */
  createHero(size: number): HTMLElement {
    const halo = el("div", { class: "presence-halo" });
    const arcHex = el("div", { class: "presence-arc presence-arc--hex" });
    const arcViolet = el("div", { class: "presence-arc presence-arc--violet" });
    const ripple = el("div", { class: "presence-ripple" });

    const orb = el("div", { class: "presence-orb", title: "poke the presence" });
    orb.style.animation = ORB_BASE;
    orb.addEventListener("click", () => this.poke());

    const face = el(
      "div",
      { class: "presence-face presence-face--hero", "aria-hidden": "true" },
      FACES.idle.t,
    );
    setStyles(face, {
      "font-size": `${Math.max(12, Math.round((size * HERO_FACE_REF) / HERO_REF))}px`,
      color: FACES.idle.c,
    });

    const box = el(
      "div",
      { class: "presence-orb-box" },
      halo,
      arcHex,
      arcViolet,
      ripple,
      orb,
      face,
    );
    setStyles(box, { width: `${size}px`, height: `${size}px` });

    const label = el("div", { class: "presence-label" }, "[ the presence ]");
    const last = el("div", { class: "presence-last" });
    const roast = el("span", { class: "presence-roast" });
    const cursor = el("span", { class: "presence-cursor", "aria-hidden": "true" }, "▌");
    const roastWrap = el(
      "div",
      { class: "presence-roast-wrap" },
      el("span", { class: "presence-roast-line" }, roast, cursor),
    );
    const caption = el("div", { class: "presence-caption" }, label, last, roastWrap);

    this.orbs.push(orb);
    this.faces.push(face);
    this.ripples.push(ripple);
    this.lastLine = last;
    this.roastNode = roast;
    this.setLast(null);

    return el("div", { class: "presence-hero" }, box, caption);
  }

  /** A small mini orb — just orb + LED face, no rings/roast — for the app
   * header on the timeline tab. Registered so react() animates it too. */
  createMini(size = MINI_REF): HTMLElement {
    const orb = el("div", { class: "presence-orb--mini" });
    orb.style.animation = ORB_BASE;

    const face = el(
      "div",
      { class: "presence-face presence-face--mini", "aria-hidden": "true" },
      FACES.idle.t,
    );
    setStyles(face, {
      "font-size": `${Math.max(6, Math.round((size * MINI_FACE_REF) / MINI_REF))}px`,
      color: FACES.idle.c,
    });

    const box = el("div", { class: "presence-mini" }, orb, face);
    setStyles(box, { width: `${size}px`, height: `${size}px` });

    this.orbs.push(orb);
    this.faces.push(face);
    return box;
  }

  /** Fire the loudest applicable reaction on all registered orbs + vignette:
   * bypass → alarm + X X toxic + toxic vignette; deny → flare + >:[ ember +
   * blood vignette; anything else (pass/loose) → ripple + ¬‿¬ spectral. */
  react(ev: FlatEvent): void {
    if (ev.bypass) {
      this.fireOrb("alarm");
      this.fireVignette("toxic");
    } else if (ev.verdict === "deny") {
      this.fireOrb("deny");
      this.fireVignette("blood");
    } else {
      this.fireOrb("pass");
    }
  }

  /** Type the latest roast ~26ms/tick into the retained node. A new roast
   * cancels any in-progress typing. UNTRUSTED text — textContent only. */
  typeRoast(text: string): void {
    window.clearInterval(this.typeTimer);
    const node = this.roastNode;
    if (!node) return;
    node.textContent = "";
    let i = 0;
    this.typeTimer = window.setInterval(() => {
      i += 1 + (i % 3 === 0 ? 1 : 0); // reference cadence: every 3rd tick reveals 2 chars
      node.textContent = text.slice(0, i);
      if (i >= text.length) window.clearInterval(this.typeTimer);
    }, TYPE_MS);
  }

  /** Update the "LAST :: DENY / Bash / 12s ago" line, colored by verdict
   * (bypass outranks). Null → the quiet-veil placeholder. */
  setLast(ev: FlatEvent | null): void {
    const node = this.lastLine;
    if (!node) return;
    if (!ev) {
      node.textContent = "the veil is quiet";
      node.style.color = SPECTRAL;
      return;
    }
    const label = ev.bypass ? "BYPASS" : ev.verdict.toUpperCase();
    node.textContent = `LAST :: ${label} / ${ev.tool} / ${ago(ev.tsMs)}`;
    node.style.color = verdictColor(ev.verdict, ev.bypass);
  }

  /** The fixed full-window overlay that deny/bypass vignettes animate. */
  setVignetteEl(node: HTMLElement): void {
    this.vignette = node;
  }

  // ── internals ────────────────────────────────────────────────

  /** Easter egg: clicking the orb flashes the happy face. */
  private poke(): void {
    this.lockFace("happy", FACE_LOCK_HAPPY);
  }

  private fireOrb(kind: "alarm" | "deny" | "pass"): void {
    const anim =
      kind === "alarm"
        ? "alarm-bypass 900ms steps(1,end) 1"
        : kind === "deny"
          ? "flare-deny 640ms cubic-bezier(.2,.9,.15,1) 1"
          : null;
    if (anim) {
      for (const orb of this.orbs) {
        // Restart trick: none → reflow → new value, then restore the base.
        orb.style.animation = "none";
        void orb.offsetWidth;
        orb.style.animation = `${anim}, ${ORB_BASE}`;
        window.setTimeout(() => {
          if (orb.isConnected) orb.style.animation = ORB_BASE;
        }, ORB_RESTORE);
      }
    } else {
      // pass: one-shot ripple on the hidden ring (hero only has one).
      for (const rp of this.ripples) {
        rp.style.animation = "none";
        void rp.offsetWidth;
        rp.style.animation = "ripple-pass 520ms ease-out 1";
        window.setTimeout(() => {
          if (rp.isConnected) {
            rp.style.animation = "none";
            rp.style.opacity = "0";
          }
        }, RIPPLE_CLEAR);
      }
    }
    this.lockFace(kind, kind === "alarm" ? FACE_LOCK_ALARM : FACE_LOCK);
  }

  private fireVignette(kind: "blood" | "toxic"): void {
    const v = this.vignette;
    if (!v) return;
    v.style.animation = "none";
    void v.offsetWidth;
    v.style.animation =
      kind === "toxic"
        ? "vignette-toxic 1100ms steps(1,end) 1"
        : "vignette-blood 640ms ease-out 1";
  }

  /** Show an event face and hold it — the idle blink is locked out until the
   * hold expires and the face falls back to idle. */
  private lockFace(kind: FaceKind, holdMs: number): void {
    this.faceLocked = true;
    this.setFace(kind);
    window.clearTimeout(this.faceTimer);
    this.faceTimer = window.setTimeout(() => {
      this.faceLocked = false;
      this.setFace("idle");
    }, holdMs);
  }

  private setFace(kind: FaceKind): void {
    const f = FACES[kind];
    for (const face of this.faces) {
      face.textContent = f.t; // trusted literal glyphs
      face.style.color = f.c;
    }
  }
}

/** Coarse relative time for the LAST line — matches the reference. */
function ago(tsMs: number): string {
  const s = Math.max(1, Math.round((Date.now() - tsMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
