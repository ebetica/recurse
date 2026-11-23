// Python str.strip() without an argument, using a linear edge scan.
const PYTHON_WHITESPACE =
  /[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
export function pyStrip(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && PYTHON_WHITESPACE.test(characters[start]!)) start += 1;
  while (end > start && PYTHON_WHITESPACE.test(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end).join("");
}
