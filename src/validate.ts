// Checks the 7 rules. Per-format differences live in the adapters; here it is implemented once on top of the IR.
import { analyze, load, pathAt, type Doc } from "./ir.js";
import type { Issue, RuleId, ValidateOptions, ValidateResult } from "./types.js";

/** Rule order used to sort issues at the same position. */
export const RULES: RuleId[] = [
  "duplicate-call-id",
  "orphan-result",
  "result-not-adjacent",
  "result-not-first",
  "missing-result",
  "open-call-at-end",
  "empty-message",
];

interface Located extends Issue {
  m: number;
  p: number;
}

/** Builds the issue list from the document (does not modify the input). */
export function issuesOf(doc: Doc): Issue[] {
  const a = analyze(doc);
  const out: Located[] = [];
  const add = (rule: RuleId, severity: Issue["severity"], m: number, p: number | undefined, ids: string[]) =>
    out.push({ rule, severity, path: pathAt(doc, m, p), ids, m, p: p ?? -1 });

  for (const call of a.calls) {
    if (call.duplicate) add("duplicate-call-id", "error", call.m, call.p, [call.part.id ?? ""]);
  }
  for (const r of a.results) {
    const id = r.part.id ?? "";
    if (!r.call) {
      if (!r.unverifiable) add("orphan-result", "error", r.m, r.p, [id]);
    } else if (!r.adjacent) {
      // A result before its call is an error in every format. For a result after the call but across turns, severity differs by format.
      const severity = r.m <= r.call.m ? "error" : doc.adapter.adjacencySeverity;
      add("result-not-adjacent", severity, r.m, r.p, [id]);
    } else if (doc.adapter.resultsFirst && !r.first) {
      add("result-not-first", "error", r.m, r.p, [id]);
    }
  }
  // Unpaired calls are reported per call message (2 parallel calls -> 1 issue, 2 ids).
  const groups = new Map<string, { m: number; p: number; ids: string[]; closed: boolean }>();
  for (const call of a.calls) {
    if (call.result) continue;
    const key = `${call.m}:${call.closed}`;
    const g = groups.get(key) ?? { m: call.m, p: call.p, ids: [], closed: call.closed };
    g.ids.push(call.part.id ?? "");
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.closed) add("missing-result", "error", g.m, undefined, g.ids);
    else add("open-call-at-end", "warning", g.m, undefined, g.ids);
  }
  for (const m of a.empty) add("empty-message", "error", m, undefined, []);

  // Sort by position -> part -> rule so the same input always gives the same order.
  out.sort((x, y) => x.m - y.m || x.p - y.p || RULES.indexOf(x.rule) - RULES.indexOf(y.rule));
  return out.map(({ rule, severity, path, ids }) => ({ rule, severity, path, ids }));
}

/**
 * Checks a conversation history against the provider-format rules. ok is true when there are 0 errors.
 * The input is an array as is, or a request body object ({messages}, {input}, {contents}).
 */
export function validate(input: unknown, opts: ValidateOptions = {}): ValidateResult {
  const doc = load(input, opts.format, false);
  const issues = issuesOf(doc);
  return { format: doc.adapter.format, ok: issues.every((i) => i.severity !== "error"), issues };
}
