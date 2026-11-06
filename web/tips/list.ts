// The Tips pane's fixed list, in display order. Each tip leads with what to ask
// an agent, then names where the same thing is in the app.

export type TipControl =
  | "find-agent"
  | "effort"
  | "btw"
  | "skills"
  | "changes"
  | "artifacts"
  | "shortcuts"
  | "settings-appearance"
  | "settings-account";

export interface Tip {
  /** Stable key for the seen list; never reuse one for different text. */
  id: string;
  area: string;
  title: string;
  text: string;
  /** Tips about one kind of device are skipped on the other. */
  device?: "desktop" | "phone";
  /** A request typed into a new agent's or this agent's message box. */
  ask?: { where: "new" | "this"; request: string };
  /** The app control the tip's second button opens. */
  control?: TipControl;
}

export const TIPS: readonly Tip[] = [
  {
    id: "sidebar-script",
    area: "Organize",
    title: "Your sidebar is a script",
    text: "Ask an agent to rearrange your sidebar, for example “group my agents by project, with the ones waiting on me at the top”. The sidebar is a short script, and the agent writes a new one for you. You can also see the script, undo a change or go back to the original in Settings → Appearance → Sidebar.",
    ask: {
      where: "new",
      request:
        "Change my sidebar script to group agents by project, with a Needs you section at the top.",
    },
    control: "settings-appearance",
  },
  {
    id: "projects",
    area: "Organize",
    title: "Group agents by project",
    text: "Juggling several projects? Ask an agent to install the example project sidebar that comes with Recurse. Each project gets its own group with Active, Inbox and Archive, every row gets Tag… and Untag, and New agent can start straight inside a project. Tags stay hidden until a sidebar like this turns them on.",
    ask: {
      where: "new",
      request:
        "Install the example project sidebar that comes with Recurse. Ask me for my project names first.",
    },
  },
  {
    id: "needs-you",
    area: "Organize",
    title: "Let agents flag you",
    text: "Ask your agents to tag themselves needs-you whenever they're waiting on you. With the example project sidebar installed, those agents jump to a Needs you section at the top, even from the archive, so you see at a glance who needs an answer. Untag clears the flag once you've replied.",
    ask: {
      where: "this",
      request:
        "Whenever you're blocked waiting on me, tag yourself needs-you, and remove the tag once I've answered.",
    },
  },
  {
    id: "pin-snooze-archive",
    area: "Organize",
    title: "Pin, snooze and archive",
    text: "Keep your Inbox short. Hover over a row (or hold it on a phone) to pin an agent to the top, snooze it until a time you choose, or archive it. An archived agent comes back by itself when it replies, a snoozed one when its snooze ends, and Archive idle > 1 day tidies away everything that's gone quiet.",
  },
  {
    id: "jump",
    area: "Organize",
    title: "Jump to any agent",
    text: "You don't need the mouse to get around. Press f and type part of a name to jump straight to an agent, use j and k to move up and down the list, and h and l to fold and unfold subagents.",
    device: "desktop",
    control: "find-agent",
  },
  {
    id: "effort",
    area: "Agents and skills",
    title: "Pick the effort level",
    text: "Each effort level, 1 to 5, is a model plus how much it reasons: lower is faster and cheaper, higher thinks harder. Ask an agent to run its subagents at a lower level for routine work, or to change what a level means (“make level 2 use a faster model”). You can also set this agent's level with the effort button above the message box, or press e.",
    ask: {
      where: "this",
      request: "Start the subagents for routine work at effort level 2.",
    },
    control: "effort",
  },
  {
    id: "memory",
    area: "Agents and skills",
    title: "Agents remember",
    text: "Ask an agent to remember something, for example “remember that I deploy from the release branch”. It saves a short note that future conversations see, either everywhere or just in this agent's tree.",
    ask: { where: "this", request: "Remember that " },
  },
  {
    id: "skills",
    area: "Agents and skills",
    title: "Teach agents your workflows",
    text: "When you notice yourself explaining the same steps twice, ask an agent to turn them into a skill: a Markdown file of instructions agents read when they need them. You can also type / in the message box to see and use the skills you have.",
    ask: {
      where: "this",
      request: "Turn what we just did into a skill I can reuse.",
    },
    control: "skills",
  },
  {
    id: "goal",
    area: "Agents and skills",
    title: "Keep an agent on a goal",
    text: "Ask an agent to install the example goal skill that comes with Recurse, and agents can keep working until a goal is really met. Type /skill:goal all tests pass, and each time the agent stops before it's done, it's reminded to carry on.",
    ask: {
      where: "new",
      request:
        "Install the example goal and loop skills that come with Recurse for every conversation.",
    },
  },
  {
    id: "schedule",
    area: "Agents and skills",
    title: "Run something on a schedule",
    text: "Ask an agent to “check the deploy every 10 minutes and tell me if anything breaks”. It sets up a timer in the background and carries on with other work. The example loop skill does the same with /skill:loop every 10 minutes check the deploy.",
    ask: {
      where: "this",
      request:
        "Every 10 minutes, check the deploy and tell me if anything breaks.",
    },
  },
  {
    id: "subagents",
    area: "Agents and skills",
    title: "Split work across subagents",
    text: "Ask an agent to split a big task, for example “give each item in TODO.md to its own subagent and open a pull request for each”. Each subagent usually gets its own copy of the code (a Git worktree), so they don't trip over each other, and reports back when it's done. Subagents appear under their parent in the sidebar.",
    ask: {
      where: "this",
      request:
        "Split this across subagents, one worktree each, and open a pull request for each part.",
    },
  },
  {
    id: "take-over",
    area: "Agents and skills",
    title: "Talk to a subagent yourself",
    text: "Ask an agent to start a subagent you'll talk to yourself: its replies come to you instead of its parent. You can also take over a subagent that's already running with Take over, or press m; do it again to hand it back.",
    ask: {
      where: "this",
      request: "Start a subagent I can talk to directly, and tell me its name.",
    },
  },
  {
    id: "background",
    area: "Agents and skills",
    title: "Long commands run in the background",
    text: "Agents don't sit waiting on a slow command: anything still running after ten seconds moves to the background, and the agent is woken when it finishes. Ask an agent to watch CI or a log and it reacts as soon as something happens.",
    ask: {
      where: "this",
      request: "Watch CI for your branch and tell me as soon as it finishes.",
    },
  },
  {
    id: "search",
    area: "Agents and skills",
    title: "Search old conversations",
    text: "Can't remember where you discussed something? Ask an agent to search past conversations: its own, its whole tree, or every agent, including deleted ones whose history is still kept.",
    ask: { where: "new", request: "Search my past conversations for " },
  },
  {
    id: "safety",
    area: "Agents and skills",
    title: "Safety review has your back",
    text: "Before an agent runs a command or edits a file, a second model checks that it fits what you asked for. If it blocks something you really do want, just say so in your message to the agent: the reviewer reads what you wrote.",
  },
  {
    id: "box-comments",
    area: "Comments",
    title: "Point at part of an image or PDF",
    text: "You can show an agent exactly what you mean. In Files, drag a box on a PDF page, or hold Cmd (Ctrl on Windows and Linux) and drag on an image; on a phone, hold, then drag. Type your comment and the agent gets the precise region plus a cropped copy.",
  },
  {
    id: "batch-comments",
    area: "Comments",
    title: "Send comments in one go",
    text: "Leaving several comments? Cmd/Ctrl+Enter adds the one you're writing to a batch, and pressing it again sends the whole batch in a single message.",
    device: "desktop",
  },
  {
    id: "artifact-comments",
    area: "Comments",
    title: "Comment on Artifacts",
    text: "Select any text in an Artifact to comment on that exact passage. The agent revises the Artifact as a new version, and the earlier versions stay around if you want to compare.",
  },
  {
    id: "changes",
    area: "Comments",
    title: "Review code changes",
    text: "Ask an agent to open a pull request when its work is ready. The Changes pane then shows the pull request together with any uncommitted work: click a line number to comment, drag across numbers to cover a range, and send them together. Press P to look at a different pull request.",
    ask: { where: "this", request: "Open a pull request for your changes." },
    control: "changes",
  },
  {
    id: "btw",
    area: "Conversations",
    title: "Ask on the side with /btw",
    text: "Curious what an agent is up to, but don't want to interrupt it? Type /btw and your question. It starts a side conversation that knows everything the agent knows but can't change anything, and the agent carries on undisturbed.",
    control: "btw",
  },
  {
    id: "steer",
    area: "Conversations",
    title: "Steer an agent while it works",
    text: "You don't have to wait for an agent to finish. Send a message while it's working and it reads it at its next step, so you can correct course early. To stop it, press Stop or q q.",
  },
  {
    id: "revive",
    area: "Conversations",
    title: "Bring back a deleted agent",
    text: "Deleted an agent too soon? Ask an agent to revive it, for example “revive the agent that was fixing the login page”; its history is kept for the days set in Settings → Account. In the message box, /revive does the same, /compact summarises older history so the agent has room to keep going, and /clear starts the conversation fresh.",
    ask: {
      where: "new",
      request: "Revive the deleted agent that was working on ",
    },
  },
  {
    id: "model-input",
    area: "Conversations",
    title: "See exactly what the model saw",
    text: "Nothing sent to a model is hidden from you. Open System prompt at the top of any conversation to read the instructions the model works under, and click the token count under a reply to see exactly what was sent, with tokens and cost.",
  },
  {
    id: "artifacts",
    area: "Conversations",
    title: "Artifacts: documents and small apps",
    text: "Ask an agent to put a report, a design or a small app “in an Artifact” and it opens beside the conversation. Artifacts keep every version, and you can comment on them directly. You can also open them from the Artifacts pane.",
    ask: { where: "this", request: "Put that in an Artifact." },
    control: "artifacts",
  },
  {
    id: "share",
    area: "Conversations",
    title: "Share a conversation tree",
    text: "Ask an agent for a share link to its tree, which is handy for picking up on another device. Share link in the right-hand rail (on a phone, under More actions) copies the same link. It still asks for your sign-in, so it doesn't give anyone else access.",
    ask: { where: "this", request: "Give me a share link to your tree." },
  },
  {
    id: "offline",
    area: "Conversations",
    title: "Send without a connection",
    text: "Lost your connection? Send anyway. The message waits, shaded, and goes out by itself when you're back online.",
  },
  {
    id: "remotes",
    area: "Conversations",
    title: "Connect another Recurse",
    text: "Running Recurse on another machine too? Ask an agent to add it as a remote, then sign in to it under Settings → Account → Remotes. Its agents appear in your sidebar under its name, and they keep working when you close your laptop.",
    ask: {
      where: "new",
      request: "Add my other Recurse as a remote. Its address is ",
    },
    control: "settings-account",
  },
  {
    id: "keyboard",
    area: "Keyboard and phone",
    title: "Keyboard first",
    text: "The app works well from the keyboard. i starts a message and Escape leaves it, G jumps to the latest message, v opens every response's details, o opens the side pane, H hides the agent list, and t t starts a new agent. Keyboard shortcuts, at the bottom of the sidebar, lists them all.",
    device: "desktop",
    control: "shortcuts",
  },
  {
    id: "phone",
    area: "Keyboard and phone",
    title: "On your phone",
    text: "A few gestures make the phone quicker: hold a row to see its actions, swipe it left to delete, and scroll the conversation to tuck the keyboard away. Add it to your home screen and it opens like any other app.",
    device: "phone",
  },
  {
    id: "make-it-yours",
    area: "Settings",
    title: "Make it yours",
    text: "Ask an agent to switch the theme, or to give the app your own name and icon (send it the picture). You can also change these in Settings → Appearance. Notifications are the one thing only you can turn on: Settings → Account → Notifications tells this browser when a top-level agent finishes.",
    ask: { where: "new", request: "Switch to a light theme." },
    control: "settings-appearance",
  },
];
