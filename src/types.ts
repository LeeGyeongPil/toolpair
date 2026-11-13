// 공개 타입과 어댑터 인터페이스를 한곳에 모은다.
// 모든 함수는 이 타입만 주고받으므로, 새 형식을 붙일 때도 이 파일을 먼저 읽으면 된다.

/** 지원하는 대화 기록 형식 4종. */
export type Format = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

/** 형식 옵션: 직접 지정하거나 "auto"(기본)로 판별에 맡긴다. */
export type FormatOption = Format | "auto";

/** 검사 규칙 7개. README 의 규칙표와 같은 이름. */
export type RuleId =
  | "orphan-result"
  | "missing-result"
  | "open-call-at-end"
  | "duplicate-call-id"
  | "result-not-adjacent"
  | "result-not-first"
  | "empty-message";

export type Severity = "error" | "warning";

/** validate 가 돌려주는 문제 하나. path 는 입력 안의 JSON 경로(`$[1]`, `$.messages[2].content[0]`). */
export interface Issue {
  rule: RuleId;
  severity: Severity;
  path: string;
  ids: string[];
}

export interface ValidateResult {
  format: Format;
  /** error 가 0건이면 true. 경고(warning)는 ok 를 막지 않는다. */
  ok: boolean;
  issues: Issue[];
}

/** repair 가 한 일 하나. path 는 언제나 "넘겨준 입력" 안의 위치를 가리킨다. */
export type ChangeOp =
  | "drop-orphan-result"
  | "insert-synthetic-result"
  | "move-result"
  | "drop-call"
  | "drop-empty-message"
  | "merge-same-role";

export interface Change {
  op: ChangeOp;
  path: string;
  ids: string[];
}

export interface ValidateOptions {
  format?: FormatOption;
}

export interface RepairOptions {
  format?: FormatOption;
  /** 결과 없이 다음 턴으로 넘어간 호출: 합성 결과를 넣거나(기본) 호출을 지운다. */
  missingResults?: "synthesize" | "drop-call";
  /** 맨 끝의 열린 호출: 실행 중일 수 있으니 기본은 그대로 둔다. "cancel" 이면 missingResults 정책으로 닫는다. */
  openCallAtEnd?: "keep" | "cancel";
  /** 합성 결과 문구. 기본 "[cancelled] no result was recorded". */
  syntheticResult?: string | ((call: { id: string; name: string }) => string);
}

export interface RepairResult<T> {
  messages: T;
  format: Format;
  changes: Change[];
}

export interface TrimOptions {
  /** 남길 토큰 수 상한(대화 배열만 센다). */
  budget: number;
  /** 메시지 하나의 토큰 수. 기본은 근사치 defaultCountTokens. 실제 토크나이저를 넣는 것을 권장. */
  countTokens?: (message: unknown) => number;
  /** 항상 남길 메시지: 앞쪽 system/developer 메시지, 첫 user 메시지. 기본 둘 다 true. */
  pin?: { system?: boolean; firstUser?: boolean };
  format?: FormatOption;
}

export interface TrimResult<T> {
  messages: T;
  format: Format;
  /** 남은 메시지들의 토큰 합. */
  tokens: number;
  /** 버린 원자 단위(호출+결과 묶음 또는 메시지 하나) 수. */
  droppedUnits: number;
  /** 고정 메시지 + 마지막 단위만으로도 예산을 넘으면 true(그래도 결과는 항상 유효). */
  overBudget: boolean;
  /** 자르기 전에 적용한 repair 의 변경 목록. */
  changes: Change[];
}

// ---------------------------------------------------------------------------
// 내부 중간 표현(IR). 공개 API 는 아니지만 어댑터를 읽을 때 필요하다.
// ---------------------------------------------------------------------------

/** 메시지 안의 조각 하나. 호출·결과·추론·그 밖의 내용. */
export interface Part {
  kind: "call" | "result" | "thinking" | "content";
  /** 호출·결과 id. Gemini 처럼 id 가 없으면 어댑터가 위치로 만든다. */
  id?: string;
  /** 도구 이름(합성 결과·Gemini 짝 맞추기에 쓴다). */
  name?: string;
  /** 원래 JSON 노드(복사본). 출력할 때 이 노드를 그대로 쓴다. */
  node: unknown;
}

/**
 * 메시지 하나.
 * - side: 짝 규칙에서의 역할. "result" 는 결과만 담는 별도 메시지(OpenAI tool, Responses output).
 * - atomic: 메시지 자체가 조각 하나인 경우(OpenAI tool 메시지, Responses 항목). 조각을 지우면 메시지를 지운다.
 */
export interface Msg {
  side: "system" | "user" | "model" | "result" | "other";
  parts: Part[];
  node: unknown;
  atomic: boolean;
  /** parts 가 바뀌어 node 를 다시 써야 하면 true. */
  dirty: boolean;
}

/** 결과가 와야 할 자리(slot)의 종류. */
export type SlotKind =
  /** 결과가 별도 메시지로 호출 뒤에 온다(OpenAI Chat, Responses). */
  | "result-messages"
  /** 결과가 바로 다음 user 메시지 안의 조각으로 온다(Anthropic, Gemini). */
  | "next-user-message";

/** 형식별 차이를 담는 어댑터. 짝 검사·수리·자르기 로직은 이 인터페이스 위에서 한 번만 구현한다. */
export interface Adapter {
  format: Format;
  /** 요청 본문 객체에서 대화 배열이 들어 있는 키. */
  listKey: "messages" | "input" | "contents";
  slotKind: SlotKind;
  /** result-not-adjacent 의 심각도(근거가 약한 형식은 warning). */
  adjacencySeverity: Severity;
  /** Anthropic 처럼 결과가 user 메시지 맨 앞에 와야 하는지. */
  resultsFirst: boolean;
  /** user/user, model/model 이 붙으면 합칠지(빈 메시지를 지운 자리에서만). */
  mergeSameRole: boolean;
  /** JSON 노드 → 메시지(IR). 입력을 바꾸지 않는다. index 는 Gemini 위치 id 에 쓴다. */
  read(node: unknown, index: number): Msg;
  /** parts 를 node 에 다시 쓴다(dirty 일 때만 불린다). */
  write(msg: Msg): void;
  /** 조각 경로 접미사(`.tool_calls[0]`, `.content[1]`, `.parts[0]`, 원자 메시지는 ""). */
  partSuffix(msg: Msg, partIndex: number): string;
  /** result-messages 슬롯: 이 메시지가 슬롯을 닫는 경계인가(그 뒤 결과는 인접하지 않음). */
  isSlotBoundary(msg: Msg): boolean;
  /** 빈 메시지·추론만 남은 메시지인가. next 는 바로 다음 메시지(Responses reasoning 판정용). */
  isEmpty(msg: Msg, next: Msg | undefined): boolean;
  /** 진짜 user 턴(도구 결과만 나르는 메시지가 아님)인가. */
  isUserTurn(msg: Msg): boolean;
  /** 자르기 단위에서 다음 메시지와 떼면 안 되는가(Responses reasoning → 다음 항목). */
  gluesToNext(msg: Msg): boolean;
  /** 합성 결과 조각(next-user-message) 또는 결과 메시지(result-messages)를 만든다. */
  makeResult(call: Part, text: string): Msg | Part;
  /** next-user-message 슬롯이 없을 때 새 user 메시지를 만든다. */
  makeUserMessage(parts: Part[]): Msg;
  /** 같은 역할 두 메시지를 하나로 합친다(앞 메시지에 뒤 내용을 붙임). */
  merge(into: Msg, from: Msg): void;
  /** 같은 역할 판정용 역할 이름. */
  roleOf(msg: Msg): string;
}
