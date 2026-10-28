// Backend labels are path segments; browsers normalize dot-only segments.
export function validBackendLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._-]{1,32}$/.test(value) &&
    !/^\.+$/.test(value)
  );
}
