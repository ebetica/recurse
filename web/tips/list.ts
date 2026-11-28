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
  | "settings-remotes";

type TipDevice = "desktop" | "phone";

export interface Tip {
  /** Stable key for the seen list; never reuse one for different text. */
  id: string;
  area: string;
  title: string;
  text: string;
  /** Tips about one kind of device are skipped on the other. */
  device?: TipDevice;
  /** A request typed into a new agent's or this agent's message box. */
  ask?: { where: "new" | "this"; request: string };
  /** The app control the tip's second button opens. */
  control?: TipControl;
}

const TIPS: readonly Tip[] = [
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
    text: "Ask an agent to set up a project sidebar. The optional example groups top-level agents into Active, Inbox and Archive for each project. Use Tag… to assign an agent to a project, or use New agent in a project heading to start there. Tags stay hidden in the default sidebar.",
    ask: {
      where: "new",
      request:
        "Set up the example project sidebar, or make a similar layout if the example isn't available. Ask me for my project names first.",
    },
  },
  {
    id: "needs-you",
    area: "Organize",
    title: "Let agents flag you",
    text: "Ask a top-level agent to tag itself needs-you when it needs an answer. With the example project sidebar installed, that puts it in the Needs you section at the top, even if it was archived. Untag clears the flag once you've replied.",
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
    text: "In the default sidebar, hover over an Inbox row (or hold it on a phone) to pin, snooze or archive the agent. An archived agent comes back when it replies, and a snoozed one when its snooze ends. The Inbox heading’s Archive idle > 1 day action archives Inbox agents that have been idle for more than a day.",
  },
  {
    id: "sidebar-swipes",
    area: "Organize",
    title: "Swipe an agent for actions",
    text: "In the default Inbox, swipe a row left for Archive, Delete and More. A full left swipe archives it; use Restore in Archive to bring it back. Swipe right for Read or Unread and Pin. Ask an agent to change the swipe actions in your sidebar script.",
    device: "phone",
    ask: {
      where: "new",
      request:
        "Help me customize which actions appear when I swipe agents in the sidebar.",
    },
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
    text: "Select the model name below the message box to choose an effort level, including before you send the first message to a new agent. On desktop, e opens it for agents on this Recurse. Change what each level uses in Settings → Models → Effort levels. Existing conversations keep their model and reasoning until you choose an effort level again.",
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
    text: "Ask an agent to keep working toward a goal and set a reminder to continue if it stops early. If you've installed the optional goal skill, try /skill:goal all tests pass.",
    ask: {
      where: "new",
      request:
        "Ask me what goal I want to reach, then set up reminders to keep working until it's met.",
    },
  },
  {
    id: "schedule",
    area: "Agents and skills",
    title: "Run something on a schedule",
    text: "Ask an agent to “check the deploy every 10 minutes and tell me if anything breaks”. It can schedule the checks in the background. If you've installed the optional loop skill, try /skill:loop every 10 minutes check the deploy.",
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
    text: "Ask an agent to split a big task, for example “give each item in TODO.md to its own subagent and open a pull request for each”. Ask for a separate copy of the code for each so they can edit independently. Subagents report back to their parent and appear under it in the sidebar.",
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
    text: "Ask an agent to start a subagent you'll talk to yourself: its replies come to you instead of its parent. To take over an existing subagent, use Take over in the right-hand rail (Take control under More actions on a phone). On desktop, m does the same for agents on this Recurse. Use the same control to hand it back.",
    ask: {
      where: "this",
      request: "Start a subagent I can talk to directly, and tell me its name.",
    },
  },
  {
    id: "background",
    area: "Agents and skills",
    title: "Long commands run in the background",
    text: "Ask an agent to watch a build or a log and let you know when it finishes. Commands that take more than ten seconds normally keep running in the background and notify the agent when they finish. Select the terminal icon above the message box to see the commands still running.",
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
    title: "Check safety review",
    text: "Safety review checks whether actions like running a command or editing a file fit what you asked for. If it blocks an action you intended, describe what you want in your own message to the agent. Check whether review is on for this conversation by opening the model name below the message box.",
  },
  {
    id: "box-comments",
    area: "Comments",
    title: "Point at part of an image or PDF",
    text: "To comment on part of an image in Files or an Artifact document, hold Cmd (Ctrl on Windows and Linux) and drag a box. In a Files PDF, drag without a key. On a phone, hold, then drag. The agent gets the marked region and, when available, a cropped copy.",
  },
  {
    id: "batch-comments",
    area: "Comments",
    title: "Send comments in one go",
    text: "In an Artifact document or an Explorer text file, press Cmd+Enter (Ctrl+Enter on Windows and Linux) while writing a new comment to add it to a batch. Press it again when you're not editing a comment to send the batch in one message.",
    device: "desktop",
  },
  {
    id: "artifact-comments",
    area: "Comments",
    title: "Comment on Artifacts",
    text: "Select text in an Artifact document to comment on that passage. Before sending, select the highlight to edit your comment. Ask the agent to revise the Artifact and use its version menu to compare the result with an earlier version.",
  },
  {
    id: "changes",
    area: "Comments",
    title: "Review code changes",
    text: "Ask an agent to open a pull request when its work is ready. Changes shows the selected pull request alongside any uncommitted work. Select a line number to comment, or drag across numbers on desktop to comment on a range. To switch pull requests, open the comparison menu at the top of Changes or press Shift+P on desktop.",
    ask: { where: "this", request: "Open a pull request for your changes." },
    control: "changes",
  },
  {
    id: "explorer",
    area: "Comments",
    title: "Comment on a file the agent is working on",
    text: "You don't have to ask the agent to attach a file first. Open Explorer from the right-hand rail (More actions on a phone) and search by filename in the agent's working folder. Open a text file and select the lines you want to comment on. For Markdown or HTML, choose Source first.",
  },
  {
    id: "btw",
    area: "Conversations",
    title: "Ask in side chat with /btw",
    text: "In a conversation on this Recurse, type a question, then hold Send and choose Ask in side chat on a phone, or press Cmd+Enter (Ctrl+Enter on Windows and Linux) on a computer. You can also type /btw before the question. The read-only side chat starts with the agent's context while the main conversation keeps working. On a phone, tap above the side card to close it.",
    control: "btw",
  },
  {
    id: "hook-changed-call",
    area: "Conversations",
    title: "See what a hook changed",
    text: "When a hook changes a tool call before it runs, open the tool's row: under the call the agent made, Ran as changed by a hook shows what actually ran. Only you see this; the agent sees its own call and the result.",
    ask: {
      where: "new",
      request:
        "Write me a local hook that adds --no-pager to git log commands, and explain how it works.",
    },
  },
  {
    id: "steer",
    area: "Conversations",
    title: "Steer an agent while it works",
    text: "You don't have to wait for an agent to finish. Send a message while it's working to steer its next steps. To interrupt the turn instead, use Stop, or press q twice on desktop after leaving the message box.",
  },
  {
    id: "read-activity",
    area: "Conversations",
    title: "Read what an agent is doing",
    text: "While an agent is working, select its latest thought above the message box to read more, when text is available. The person icon there lists active subagents. In the conversation, select Expand all under a reply to see its activity, then open a Thought for … row or a command for details.",
  },
  {
    id: "revive",
    area: "Conversations",
    title: "Bring back a deleted agent",
    text: "Deleted an agent too soon? Ask an agent to revive it, for example “revive the agent that was fixing the login page”. History is kept for the days set in Settings → Agents → Deleted agents' history. On this Recurse, you can also type /revive to pick from deleted agents in the message box. Use /compact to summarize older history or /clear to start fresh.",
    ask: {
      where: "new",
      request: "Revive the deleted agent that was working on ",
    },
  },
  {
    id: "model-input",
    area: "Conversations",
    title: "Inspect instructions and delivered input",
    text: "Open System prompt at the top of the conversation to read the standing instructions. Open the token usage button below a reply for model usage and cost. Choose View delivered input there when available to read the message sent to the model.",
  },
  {
    id: "artifacts",
    area: "Conversations",
    title: "Artifacts: documents and small apps",
    text: "Ask an agent to put a report, a design or a small app in an Artifact, then open it from the Artifacts pane. The version menu lets you revisit earlier versions. When a document shows highlights, select Reviewed at the bottom right to clear them. You can also ask the agent to delete a published Artifact and all its versions.",
    ask: { where: "this", request: "Put that in an Artifact." },
    control: "artifacts",
  },
  {
    id: "code-block-expand",
    area: "Conversations",
    title: "Copy or expand a code block",
    text: "Each code block in a reply has a bar above it showing its language. Use the Copy button there to copy the code, or Expand to read it full screen.",
  },
  {
    id: "artifact-pages",
    area: "Conversations",
    title: "Make an Artifact with several pages",
    text: "Ask an agent to make a guide in one Artifact, with an overview that links to separate pages. Those pages open in the same pane. Use Overview to return to the first page, browser Back and Forward to retrace your steps, or Copy link to share the page you're on.",
    ask: {
      where: "this",
      request:
        "Make a Markdown guide in one Artifact, with an overview that links to a separate page for each topic.",
    },
    control: "artifacts",
  },
  {
    id: "artifact-app-state",
    area: "Conversations",
    title: "Make an Artifact app that saves your work",
    text: "Ask an agent to make a checklist or tracker in an Artifact and save your entries. An app built to save its data can remember your changes when you reopen it in the Artifacts pane, even after the agent publishes a new version.",
    ask: {
      where: "new",
      request:
        "Make a checklist app in an Artifact that saves my items and remembers which ones I've checked when I reopen it.",
    },
    control: "artifacts",
  },
  {
    id: "explorer-markdown",
    area: "Conversations",
    title: "Read Markdown in Explorer",
    text: "Open a Markdown file in Explorer to see formatted text and images. Choose Source to read the original text, or Edit to change it. Double-click a figure in Explorer or Files to enlarge it. On a phone, tap the figure instead.",
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
    text: "Running Recurse on another machine too? Ask an agent to add it as a remote, then sign in to it under Settings → Remotes. Its agents appear in your sidebar under its name, and they keep working when you close your laptop.",
    ask: {
      where: "new",
      request: "Add my other Recurse as a remote. Its address is ",
    },
    control: "settings-remotes",
  },
  {
    id: "keyboard",
    area: "Keyboard and phone",
    title: "Keyboard first",
    text: "Press i to write a message or Escape to leave the message box. G jumps to the latest message, v toggles response details, and o finds panes and items such as Artifacts. Press H to show or hide the agent list, or t twice to start a new agent. See Keyboard shortcuts at the bottom of the sidebar for the full list.",
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
    text: "Ask an agent to switch the theme, or to give the app your own name and icon (send it the picture). You can also change these in Settings → Appearance.",
    ask: { where: "new", request: "Switch to a light theme." },
    control: "settings-appearance",
  },
  {
    id: "gemini-sign-in",
    area: "Settings",
    title: "Use Gemini in a conversation",
    text: "Save a Google AI Studio API key in Settings → Providers → Gemini. To use Gemini, choose it for an effort level in Settings → Models → Effort levels, then pick that level for the conversation. Signing in doesn't change your existing model choices.",
  },
  {
    id: "finish-notifications",
    area: "Settings",
    title: "Know when an agent has finished",
    text: "A dot in the agent list means the agent replied while you weren't viewing its conversation. Open the conversation to clear the dot. For browser notifications from top-level agents and subagents you've taken over, turn on Agent finished in Settings → Agents → Notifications. Select a notification to open that conversation.",
  },
  {
    id: "check-updates",
    area: "Settings",
    title: "Check for a Recurse update",
    text: "Look below the Settings categories for the installed version. If Check for updates is available, use it to check now rather than waiting. When a new version is available, choose Update now.",
  },
];

export function tipsForDevice(device: TipDevice): readonly Tip[] {
  return TIPS.filter(
    (tip) => tip.device === undefined || tip.device === device,
  );
}
