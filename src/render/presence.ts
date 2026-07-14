// The presence: a living orb in the header that idles calm and REACTS when an
// event lands. Pure CSS-class choreography — it never writes text/content, so it
// can never be an XSS vector. Reduced-motion is honored by the stylesheet.

import type { SeanceEvent } from "../model/types";
import { hasBypass, verdictOf } from "../model/types";

type ReactClass = "flare-deny" | "ripple-pass" | "alarm-bypass" | "flare-warn";

export class Presence {
  constructor(
    private orb: HTMLElement,
    private vignette: HTMLElement,
  ) {}

  /** React to a freshly-landed event with the loudest applicable animation. */
  react(ev: SeanceEvent): void {
    if (hasBypass(ev)) {
      this.fire("alarm-bypass");
      return; // a bypass outranks everything
    }
    const v = verdictOf(ev);
    if (v === "deny") {
      this.fire("flare-deny");
      this.fireVignette();
    } else if (ev.kind === "governing" && ev.pre?.action === "detect") {
      this.fire("flare-warn");
    } else {
      this.fire("ripple-pass");
    }
  }

  /** A brief highlight when a late post line resolves an existing row. */
  pulseLatePost(row: HTMLElement): void {
    restart(row, "post-resolved");
  }

  private fire(cls: ReactClass): void {
    restart(this.orb, cls);
  }

  private fireVignette(): void {
    restart(this.vignette, "deny");
  }
}

/** Re-trigger a one-shot animation class (remove, reflow, re-add). */
function restart(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  // force reflow so re-adding restarts the animation
  void node.offsetWidth;
  node.classList.add(cls);
  const clearOnEnd = () => {
    node.classList.remove(cls);
    node.removeEventListener("animationend", clearOnEnd);
  };
  node.addEventListener("animationend", clearOnEnd);
}
