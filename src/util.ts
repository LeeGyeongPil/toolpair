// 작은 공용 도우미. node: 모듈을 쓰지 않아 브라우저에서도 돈다.
import { InvalidInputError } from "./errors.js";

/** 일반 객체(배열·null 이 아닌 object)인가. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON 모양 데이터의 깊은 복사. 입력을 절대 바꾸지 않기 위해 처음에 한 번 복사한다.
 * structuredClone 과 달리 같은 객체가 두 번 나오면 서로 다른 복사본을 만들어,
 * 노드마다 원래 경로를 하나씩 붙일 수 있게 한다. 순환 참조는 InvalidInputError.
 */
export function cloneJson<T>(value: T): T {
  const inProgress = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null) return v;
    if (inProgress.has(v)) throw new InvalidInputError("input contains a circular reference", "circular");
    inProgress.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      // Date 같은 특수 객체는 JSON 데이터가 아니므로 그대로 둔다.
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

/** 문자열이면 그대로, 아니면 "" (id·이름을 안전하게 꺼낼 때). */
export function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}
