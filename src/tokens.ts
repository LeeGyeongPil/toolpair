// 기본 토큰 계산: JSON 문자열 길이 / 4 를 올림한 근사치.
// 영어 기준 대략값이라 한국어·코드에서는 실제보다 적게 나올 수 있다.
// 정확한 예산이 필요하면 trimToBudget 의 countTokens 에 실제 토크나이저를 넣는다.
export function defaultCountTokens(message: unknown): number {
  const json = JSON.stringify(message);
  return json === undefined ? 0 : Math.ceil(json.length / 4);
}
