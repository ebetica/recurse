// Theme CSS is parsed off-document and rebuilt before adoption.
// Comments, escapes and unknown resource functions/rules fail closed.
// Shell CSP limits styles, fonts and connections; explicit image loads remain.
// Protected UI suspends the whole sheet using app state, not themed styles.

const allowedFunctions = new Set(
  `var calc min max clamp env rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark
   linear-gradient repeating-linear-gradient radial-gradient repeating-radial-gradient conic-gradient repeating-conic-gradient
   translate translateX translateY translateZ translate3d scale scaleX scaleY scaleZ scale3d rotate rotateX rotateY rotateZ rotate3d
   skew skewX skewY matrix matrix3d perspective blur brightness contrast grayscale hue-rotate invert opacity saturate sepia drop-shadow
   cubic-bezier steps linear counter counters circle ellipse inset polygon path rect xywh round mod rem abs sign pow sqrt hypot log exp sin cos tan asin acos atan atan2`
    .toLowerCase()
    .split(/\s+/),
);
let sheet: CSSStyleSheet | undefined;
let observer: MutationObserver | undefined;

/** Scan CSS strings, identifiers, function and URL tokens in every value. */
function safeValue(value: string): boolean {
  if (value.includes("\\") || value.includes("/*")) return false;
  let index = 0;
  const space = (char: string | undefined) =>
    char !== undefined && " \t\n\r\f".includes(char);
  const nameStart = (char: string | undefined) =>
    char !== undefined && /[_a-z\u0080-\uffff]/i.test(char);
  const name = (char: string | undefined) =>
    nameStart(char) || (char !== undefined && /[0-9-]/.test(char));
  const whitespace = () => {
    while (space(value[index])) index++;
  };
  const string = (): string | null => {
    const quote = value[index++]!;
    const start = index;
    while (index < value.length && value[index] !== quote) {
      if ("\n\r\f".includes(value[index]!)) return null;
      index++;
    }
    if (index === value.length) return null;
    const text = value.slice(start, index);
    index++;
    return text;
  };
  while (index < value.length) {
    const char = value[index]!;
    if (char === '"' || char === "'") {
      if (string() === null) return false;
      continue;
    }
    if (
      !nameStart(char) &&
      !(
        char === "-" &&
        (nameStart(value[index + 1]) || value[index + 1] === "-")
      )
    ) {
      index++;
      continue;
    }
    const start = index++;
    while (name(value[index])) index++;
    const identifier = value.slice(start, index).toLowerCase();
    if (value[index] !== "(") continue;
    index++;
    if (identifier !== "url") {
      if (!allowedFunctions.has(identifier)) return false;
      continue;
    }
    whitespace();
    let target: string;
    if (value[index] === '"' || value[index] === "'") {
      const text = string();
      if (text === null) return false;
      target = text;
    } else {
      const start = index;
      while (
        index < value.length &&
        value[index] !== ")" &&
        !space(value[index])
      ) {
        const char = value[index++]!;
        const code = char.charCodeAt(0);
        if (
          char === '"' ||
          char === "'" ||
          char === "(" ||
          code < 32 ||
          code === 127
        )
          return false;
      }
      target = value.slice(start, index);
    }
    whitespace();
    if (value[index++] !== ")") return false;
    if (!target.startsWith("#") && !target.toLowerCase().startsWith("data:"))
      return false;
  }
  return true;
}

function declarations(style: CSSStyleDeclaration): string {
  return Array.from(style)
    .filter((property) => safeValue(style.getPropertyValue(property)))
    .map(
      (property) =>
        `${CSS.escape(property)}:${style.getPropertyValue(property)}${style.getPropertyPriority(property) ? "!important" : ""};`,
    )
    .join("");
}

/** Rebuild only known rules; no unexamined cssText reaches the document. */
function rules(input: CSSRuleList): string {
  return Array.from(input)
    .map((rule): string => {
      if (rule instanceof CSSStyleRule)
        return `${rule.selectorText}{${declarations(rule.style)}${rule.cssRules ? rules(rule.cssRules) : ""}}`;
      if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule)
        return safeValue(rule.conditionText)
          ? `${rule instanceof CSSMediaRule ? "@media" : "@supports"} ${rule.conditionText}{${rules(rule.cssRules)}}`
          : "";
      if (rule instanceof CSSKeyframesRule)
        return `@keyframes ${CSS.escape(rule.name)}{${Array.from(rule.cssRules)
          .map((frame) =>
            frame instanceof CSSKeyframeRule
              ? `${frame.keyText}{${declarations(frame.style)}}`
              : "",
          )
          .join("")}}`;
      return "";
    })
    .join("");
}

function protectedSurfacePresent(): boolean {
  return Array.from(document.querySelectorAll("[data-theme-protected]")).some(
    (element) => {
      if (element.closest("[hidden], dialog:not([open])")) return false;
      return true;
    },
  );
}

function updateAdoption(): void {
  if (!sheet) return;
  const others = document.adoptedStyleSheets.filter((item) => item !== sheet);
  const enabled = !protectedSurfacePresent();
  if (document.adoptedStyleSheets.includes(sheet) === enabled) return;
  document.adoptedStyleSheets = enabled ? [...others, sheet] : others;
}

/** No raw theme CSS is ever inserted into a style element or the shell HTML. */
export function applyCustomThemeCss(css: string): void {
  if (
    !("adoptedStyleSheets" in document) ||
    !("replaceSync" in CSSStyleSheet.prototype)
  )
    return;
  const disabled =
    new URLSearchParams(location.search).get("customCss") === "off";
  if (!css || disabled || css.length > 50_000) {
    observer?.disconnect();
    if (sheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (item) => item !== sheet,
      );
      sheet.replaceSync("");
    }
    return;
  }
  sheet ??= new CSSStyleSheet();
  observer ??= new MutationObserver(updateAdoption);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "open", "class", "data-theme-protected"],
  });
  const parsed = new CSSStyleSheet();
  parsed.replaceSync(css);
  sheet.replaceSync(rules(parsed.cssRules));
  updateAdoption();
}
