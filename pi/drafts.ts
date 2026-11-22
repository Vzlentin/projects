/**
 * `/drafts`: the user picks a draft of a thread of the project, it goes to the clipboard, and each draft whose text the
 * copy holds becomes sent.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "../src/protocol/project.ts";
import type { Projects } from "./index.ts";

/** What `/drafts` uses of the projects install: the store of the project, to read the drafts and to mark them sent. */
type DraftsProjects = Pick<Projects, "projectProtocol" | "protocol" | "requests" | "tool">;

/** What `/drafts` uses of the context of a command. */
export type DraftsContext = Pick<ExtensionCommandContext, "mode" | "signal"> & {
	readonly ui: Pick<ExtensionCommandContext["ui"], "notify" | "select">;
	readonly sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getSessionId">;
};

/** What `/drafts` uses of the API of Pi: the command. */
export type DraftsApi = {
	registerCommand(
		name: string,
		options: { description: string; handler: (args: string, ctx: DraftsContext) => Promise<void> },
	): void;
};

/** Puts a text on the clipboard. */
export type CopyText = (text: string) => Promise<void>;

/**
 * Registers `/drafts`, whose caller is the session ID. It reads the drafts out of every thread of the project, from a
 * host that it starts when none runs. The user picks one, and `copyText` puts its text on the clipboard. Then each draft
 * that it read whose text the copied text holds becomes sent. A read that fails copies nothing. A mark that fails gives
 * a warning, and the copy stays done.
 */
export function registerDrafts(pi: DraftsApi, projects: DraftsProjects, copyText: CopyText): void {
	pi.registerCommand("drafts", {
		description: "Copy a draft of a thread of the project, and mark it sent",
		handler: async (_args, ctx) => copyDraft(ctx, projects, copyText),
	});
}

async function copyDraft(ctx: DraftsContext, projects: DraftsProjects, copyText: CopyText): Promise<void> {
	const { protocol } = projects;

	if (ctx.mode !== "tui") {
		ctx.ui.notify("/drafts requires interactive mode", "error");

		return;
	}

	const signal = ctx.signal ?? new AbortController().signal;
	let drafts: Message[];

	try {
		drafts = (await readMessages(projects, signal)).filter(
			(message) => message.direction === "out" && message.state === "draft",
		);
	} catch (error) {
		ctx.ui.notify(`Could not read the drafts: ${protocol.errorMessage(error)}`, "warning");

		return;
	}

	if (drafts.length === 0) {
		ctx.ui.notify("No drafts to copy", "info");

		return;
	}

	const options = new Map(drafts.map((draft) => [`Draft ${draft.id}: ${firstLine(draft.text)}`, draft]));
	const chosen = await ctx.ui.select("Copy a draft", [...options.keys()]);
	const picked = chosen === undefined ? undefined : options.get(chosen);

	if (picked === undefined) return;

	try {
		await copyText(picked.text);
	} catch (error) {
		ctx.ui.notify(`Copy failed: ${protocol.errorMessage(error)}`, "error");

		return;
	}

	ctx.ui.notify(describe(picked.text), "info");
	await markDrafts(ctx, projects, drafts, picked.text, signal);
}

/** The first line of `text` that is not empty, without whitespace at its ends, and at most 60 characters. */
function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((l) => l.trim())
			?.trim()
			.slice(0, 60) ?? ""
	);
}

function describe(text: string): string {
	const lines = text.split("\n");

	return `Copied ${lines.length} line${lines.length === 1 ? "" : "s"}: ${firstLine(text)}`;
}

/** The text with each run of whitespace as one space, and without whitespace at its ends. */
function normalized(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Marks sent each draft of `drafts` whose text the copied text `text` holds, with the session as the caller. A mark that
 * fails gives a warning, and the next draft goes on.
 */
async function markDrafts(
	ctx: DraftsContext,
	projects: DraftsProjects,
	drafts: readonly Message[],
	text: string,
	signal: AbortSignal,
): Promise<void> {
	const { protocol, tool } = projects;
	const copied = normalized(text);
	const caller = ctx.sessionManager.getSessionId();

	for (const draft of drafts.filter((message) => copied.includes(normalized(message.text)))) {
		try {
			await tool.sendToHost({ type: "message", action: "mark", caller, message: draft.id, state: "sent" }, signal);
			ctx.ui.notify(`Draft ${draft.id} marked sent`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not mark draft ${draft.id} sent: ${protocol.errorMessage(error)}`, "warning");
		}
	}
}

/**
 * The messages of every thread of the project, from a host that the reads start when none runs. It throws when the host
 * replies with another value than a thread list or the messages of a thread.
 */
async function readMessages(projects: DraftsProjects, signal: AbortSignal): Promise<Message[]> {
	const { projectProtocol, requests, tool } = projects;

	const list = requests.replyOf(
		projectProtocol.ThreadList,
		await tool.sendToHost({ type: "thread", action: "list" }, signal),
		"threads",
	);

	const reads = await Promise.all(
		list.threads.map((thread) => tool.sendToHost({ type: "thread", action: "read", id: thread.id }, signal)),
	);

	return reads.flatMap((reply) => requests.replyOf(projectProtocol.ThreadMessages, reply, "messages").messages);
}
