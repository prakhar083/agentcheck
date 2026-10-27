/**
 * Structural subset match: every key present in `expected` must exist in
 * `actual` with a matching value. Objects recurse; arrays must have the same
 * length and match element-wise; everything else uses strict equality.
 */
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matchesSubset(actual[i], item))
    );
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => key in actual && matchesSubset(actual[key], value));
  }
  return Object.is(actual, expected);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
