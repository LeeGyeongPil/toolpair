// Default token count: an approximation, the JSON string length / 4 rounded up.
// A rough figure based on English, so it may come out lower than the real count for non-English text and code.
// If you need an exact budget, pass a real tokenizer as countTokens of trimToBudget.
export function defaultCountTokens(message: unknown): number {
  const json = JSON.stringify(message);
  return json === undefined ? 0 : Math.ceil(json.length / 4);
}
