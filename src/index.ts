// toolpair 공개 API. 런타임 의존성 0, node: 모듈 미사용(브라우저에서도 돈다).
export { detectFormat } from "./detect.js";
export { validate, RULES } from "./validate.js";
export { repair, DEFAULT_SYNTHETIC_RESULT } from "./repair.js";
export { trimToBudget } from "./trim.js";
export { defaultCountTokens } from "./tokens.js";
export { ToolpairError, InvalidInputError, UnknownFormatError } from "./errors.js";
export type { ErrorCode, ErrorParams } from "./errors.js";
export type {
  Format,
  FormatOption,
  RuleId,
  Severity,
  Issue,
  ValidateOptions,
  ValidateResult,
  ChangeOp,
  Change,
  RepairOptions,
  RepairResult,
  TrimOptions,
  TrimResult,
  Adapter,
  Msg,
  Part,
  SlotKind,
} from "./types.js";
