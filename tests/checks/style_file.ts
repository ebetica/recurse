/** One style input with a shared, lazy TypeScript parse and comment-free view. */
import ts from "typescript";
import { blankTsComments } from "./ts_comments.ts";

export type StyleText = Readonly<{ file: string; text: string }>;

export class StyleFile {
  #source?: ts.SourceFile;
  #code?: string;

  constructor(
    readonly file: string,
    readonly text: string,
  ) {}

  static from(input: StyleText): StyleFile {
    return input instanceof StyleFile
      ? input
      : new StyleFile(input.file, input.text);
  }

  get source(): ts.SourceFile {
    return (this.#source ??= ts.createSourceFile(
      this.file,
      this.text,
      ts.ScriptTarget.Latest,
      true,
    ));
  }

  get code(): string {
    return (this.#code ??= blankTsComments(this.source));
  }
}
