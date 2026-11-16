// Live-conversation-owned response chains; WeakMap ownership, no persistence.
// Bound memory/drift: 24 reviews, 262144 chars (~65k tokens), policy included.
// Oversized reviews see all evidence but aren't retained. Route/policy or
// evidence-boundary changes reset; only clean first-attempt replies commit.
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "@earendil-works/pi-ai";

const MAX_HISTORY_CHARS = 262_144;
const MAX_HISTORY_REVIEWS = 24;

type History = {
  key: string;
  transcript: string;
  messages: Message[];
  reviews: number;
};

export class ReviewHistory {
  private state?: History;

  /** Select a complete prefix; never mutate it while a request is in flight. */
  prepare(
    key: string,
    transcript: string,
    systemPrompt: string,
    render: (delta: string, initial: boolean) => UserMessage[],
  ) {
    let prior = this.state;
    if (
      prior?.key !== key ||
      !transcript.startsWith(prior.transcript) ||
      prior.reviews >= MAX_HISTORY_REVIEWS
    )
      prior = undefined;
    let appended = render(
      transcript.slice(prior?.transcript.length ?? 0),
      !prior,
    );
    if (
      prior &&
      systemPrompt.length +
        JSON.stringify([...prior.messages, ...appended]).length >
        MAX_HISTORY_CHARS
    ) {
      prior = undefined;
      appended = render(transcript, true);
    }
    if (!prior) this.state = undefined;
    const messages = [...(prior?.messages ?? []), ...appended];
    return {
      messages,
      commit: (response: AssistantMessage) => {
        const completed = [...messages, response];
        const chars = systemPrompt.length + JSON.stringify(completed).length;
        this.state =
          chars <= MAX_HISTORY_CHARS
            ? {
                key,
                transcript,
                messages: completed,
                reviews: (prior?.reviews ?? 0) + 1,
              }
            : undefined;
      },
    };
  }
}
