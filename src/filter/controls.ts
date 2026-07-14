// Builds the filter/search bar and emits FilterState patches. Tool and
// matched-rule dropdowns are populated from OBSERVED values (options appear as
// new tools/rules are seen). Free-text is debounced.

import { el } from "../render/dom";
import type { FilterState } from "./filter";
import type { SeanceEvent } from "../model/types";

const VERDICT_CHIPS: { label: string; verdict?: FilterState["verdict"] }[] = [
  { label: "all" },
  { label: ">:[ deny", verdict: "deny" },
  { label: "(¬‿¬) pass", verdict: "pass" },
  { label: "◌ loose", verdict: "loose" },
];

const CATEGORIES = [
  "cred-access",
  "pipe-to-shell",
  "destructive",
  "persistence",
  "network-exfil",
  "unknown",
] as const;

export class Controls {
  private toolSelect!: HTMLSelectElement;
  private ruleSelect!: HTMLSelectElement;
  private tools = new Set<string>();
  private rules = new Set<string>();
  private activeCats = new Set<string>();
  private activeVerdict?: FilterState["verdict"];
  private bypassOnly = false;
  private debounce = 0;

  constructor(private onChange: (patch: Partial<FilterState>) => void) {}

  build(): HTMLElement {
    const chipRow = el("div", { class: "chip-row" });
    for (const c of VERDICT_CHIPS) {
      const b = el("button", { class: "fchip", "data-verdict": c.verdict ?? "all" }, c.label);
      if (!c.verdict) b.classList.add("active");
      b.addEventListener("click", () => {
        for (const other of chipRow.querySelectorAll(".fchip")) other.classList.remove("active");
        b.classList.add("active");
        this.activeVerdict = c.verdict;
        this.emit();
      });
      chipRow.appendChild(b);
    }

    const bypassBtn = el("button", { class: "fchip alarm" }, "⚠ bypass");
    bypassBtn.addEventListener("click", () => {
      this.bypassOnly = !this.bypassOnly;
      bypassBtn.classList.toggle("active", this.bypassOnly);
      this.emit();
    });
    chipRow.appendChild(bypassBtn);

    const catRow = el("div", { class: "cat-row" });
    for (const cat of CATEGORIES) {
      const dot = el("button", { class: "cat-toggle", "data-category": cat, title: cat }, cat);
      dot.addEventListener("click", () => {
        if (this.activeCats.has(cat)) this.activeCats.delete(cat);
        else this.activeCats.add(cat);
        dot.classList.toggle("active", this.activeCats.has(cat));
        this.emit();
      });
      catRow.appendChild(dot);
    }

    this.toolSelect = el("select", { class: "fselect", title: "tool" }) as HTMLSelectElement;
    this.ruleSelect = el("select", { class: "fselect", title: "matched rule" }) as HTMLSelectElement;
    this.resetSelect(this.toolSelect, "all tools");
    this.resetSelect(this.ruleSelect, "all rules");
    this.toolSelect.addEventListener("change", () => this.emit());
    this.ruleSelect.addEventListener("change", () => this.emit());

    const search = el("input", {
      class: "search",
      title: "search commands, roasts, reasons",
    }) as HTMLInputElement;
    search.type = "text";
    search.placeholder = "⌕ search the aftermath…";
    search.addEventListener("input", () => {
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => this.emit(), 120);
    });
    this.searchInput = search;

    return el(
      "div",
      { class: "filter-bar grimoire" },
      chipRow,
      catRow,
      el("div", { class: "selects" }, this.toolSelect, this.ruleSelect),
      search,
    );
  }

  private searchInput!: HTMLInputElement;

  /** Learn tool/rule values from an event so the dropdowns stay populated. */
  observe(ev: SeanceEvent): void {
    const tool = ev.ghost?.tool ?? (ev.kind === "governing" ? ev.pre?.toolName : ev.sentinel?.toolName);
    if (tool && !this.tools.has(tool)) {
      this.tools.add(tool);
      this.addOption(this.toolSelect, tool);
    }
    const rule = ev.kind === "governing" ? ev.pre?.matchedRule : ev.sentinel?.matchedRule;
    if (rule && !this.rules.has(rule)) {
      this.rules.add(rule);
      this.addOption(this.ruleSelect, rule);
    }
  }

  private resetSelect(sel: HTMLSelectElement, allLabel: string): void {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = allLabel;
    sel.appendChild(opt);
  }

  private addOption(sel: HTMLSelectElement, value: string): void {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    sel.appendChild(opt);
  }

  private emit(): void {
    const patch: Partial<FilterState> = {
      verdict: this.activeVerdict,
      bypassOnly: this.bypassOnly,
      tool: this.toolSelect.value || undefined,
      matchedRule: this.ruleSelect.value || undefined,
      categories: this.activeCats.size ? [...this.activeCats] : undefined,
      text: this.searchInput.value,
    };
    this.onChange(patch);
  }
}
