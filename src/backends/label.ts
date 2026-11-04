// Backend labels are path segments; browsers normalize dot-only segments.
export function validBackendLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._-]{1,32}$/.test(value) &&
    !/^\.+$/.test(value)
  );
}

/**
 * What a remote calls home label `label` relayed by key `keyId`: the label
 * (over 25 chars: 18 plus a 6-digit hash) and the key's unique 6-digit prefix.
 */
export function keyedLabel(label: string, keyId: string): string {
  let hash = 0x811c9dc5;
  for (const char of label)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const name =
    label.length <= 25
      ? label
      : `${label.slice(0, 18)}-${(hash >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
  return `${name}.${keyId.slice(0, 6)}`;
}
