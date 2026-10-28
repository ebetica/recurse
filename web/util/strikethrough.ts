// Approximation tildes must not close strikethrough before a letter or digit.
// Agent messages and agent-authored Artifacts share these boundaries.
import type { MarkedExtension } from "marked";

export const strikethrough: MarkedExtension = {
  tokenizer: { del: () => undefined },
  extensions: [
    {
      name: "del",
      level: "inline",
      tokenizer(src, tokens) {
        const previous = tokens.at(-1)?.raw ?? "";
        if (/[\p{L}\p{N}]$/u.test(previous)) return;
        const match =
          /^(~~?)(?=[^\s~])((?:(?!\1)[\s\S])*?[^\s~])\1(?![\p{L}\p{N}~])/u.exec(
            src,
          );
        if (!match) return;
        return {
          type: "del",
          raw: match[0],
          text: match[2],
          tokens: this.lexer.inlineTokens(match[2]),
        };
      },
    },
  ],
};
