// Paste-back sign-in for MCP servers and Claude/ChatGPT subscriptions: a link
// opens the sign-in page in a new tab (a direct tap, never pop-up blocked); the
// user pastes the unreachable redirect page's address (or a code) and submits.

export interface PasteSignIn {
  /** Provider or server name, used in the link and field labels. */
  name: string;
  /** The provider's sign-in page. */
  url: string;
  /** The redirect address whose unreachable page the user pastes back. */
  redirectUrl: string;
  /** Text already typed, kept across re-renders. */
  answer?: string;
  onInput?: (answer: string) => void;
  busy?: boolean;
  onSubmit: (answer: string) => void;
}

export function pasteSignInForm(options: PasteSignIn): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "item paste-sign-in";
  const open = document.createElement("a");
  open.className = "btn";
  open.href = options.url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = `Open ${options.name} sign-in`;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = `After approving, your browser shows an unreachable ${options.redirectUrl} page. Paste that page's full address here.`;
  const answer = document.createElement("input");
  answer.className = "text-field";
  answer.required = true;
  answer.autocomplete = "off";
  answer.spellcheck = false;
  answer.value = options.answer ?? "";
  answer.oninput = () => options.onInput?.(answer.value);
  answer.setAttribute(
    "aria-label",
    `Address after signing in to ${options.name}`,
  );
  const finish = document.createElement("button");
  finish.className = "btn";
  finish.type = "submit";
  finish.textContent = "Finish sign-in";
  finish.disabled = !!options.busy;
  form.onsubmit = (event) => {
    event.preventDefault();
    options.onSubmit(answer.value.trim());
  };
  form.append(open, hint, answer, finish);
  return form;
}
