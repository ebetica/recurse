// Normal admission and post-clear replay share the same submission format.
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SubmissionDraft } from "@earendil-works/pi-durable";
import { splitPiUserText } from "../../view/session_entries";

export interface Held {
  requestId: string;
  content: string;
  images?: readonly ImageContent[];
  note: boolean;
}

/** One send as a submission: an input, or a note written as a user message. */
export function draft(held: Held): SubmissionDraft {
  const content = held.images?.length
    ? [{ type: "text" as const, text: held.content }, ...held.images]
    : held.content;
  return held.note
    ? {
        type: "write",
        requestId: held.requestId,
        entry: {
          kind: "recurse.note",
          model: [{ role: "user", content, timestamp: Date.now() }],
        },
      }
    : {
        type: "input",
        content,
        requestId: held.requestId,
        // Invariant: Only explicit operator input cuts model output; all other
        // origins retain boundary steering. Pi treats interrupt as steer while
        // tools run.
        whenBusy:
          splitPiUserText(held.content)[0] === "operator"
            ? "interrupt"
            : "steer",
      };
}

/** Service input never enters while review is or may become OFF. */
export function reviewedOnly(requestId: string): boolean {
  return requestId.startsWith("op:service:");
}
