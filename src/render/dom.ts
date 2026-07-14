// The ONLY node factory in the app. DOM is built with createElement +
// textContent exclusively — never innerHTML, never an HTML template string.
// Every untrusted log payload (command, roast, reason, matched_rule, probe
// mutation, tool output) flows through here as a text node, which the DOM
// escapes automatically. The strict CSP is the backstop; this is the primary
// defense. If you ever reach for innerHTML, stop.

type Attrs = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined;

/** Create an element. String children become auto-escaped text nodes. Only a
 * safe allowlist of attributes is honored (class, title, role, hidden, data-,
 * aria-); href/src/style/on-handlers are never set from data. */
export function el(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (
      k === "class" ||
      k === "title" ||
      k === "role" ||
      k === "hidden" ||
      k.startsWith("data-") ||
      k.startsWith("aria-")
    ) {
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children) append(node, c);
  return node;
}

/** Explicit untrusted-text node — named for intent at call sites. */
export function txt(value: string | number | undefined | null): Text {
  return document.createTextNode(value == null ? "" : String(value));
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) append(f, c);
  return f;
}

function append(parent: Node, c: Child): void {
  if (c == null) return;
  parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
}

/** Remove all children of a node (safe clear before a rebuild). */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
