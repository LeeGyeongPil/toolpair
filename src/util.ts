// Small shared helpers. No node: modules, so it also runs in browsers.
import { InvalidInputError } from "./errors.js";

/** Is it a plain object (an object that is not an array or null)? */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep copy of JSON-shaped data. Copies once at the start so the input is never modified.
 * Unlike structuredClone, if the same object appears twice it makes separate copies,
 * so each node can carry its own original path. Circular references throw InvalidInputError.
 */
export function cloneJson<T>(value: T): T {
  const inProgress = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null) return v;
    if (inProgress.has(v)) throw new InvalidInputError("input contains a circular reference", "circular");
    inProgress.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      // Special objects such as Date are not JSON data, so leave them as they are.
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) out[k] = walk(item);
      return out;
    } finally {
      inProgress.delete(v);
    }
  };
  return walk(value) as T;
}

/** The string itself if it is a string, otherwise "" (for safely extracting ids and names). */
export function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}
