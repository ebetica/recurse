// The model id charset shared by the catalog and ladder.
const MODEL_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
export function validModelScopeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x00-\x7f]+$/u.test(value) &&
    MODEL_SCOPE_RE.test(value)
  );
}
