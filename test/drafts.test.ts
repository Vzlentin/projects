import type { Host } from "@vzlentin/harness/host";
import * as protocol from "@vzlentin/harness/protocol";
import * as tool from "@vzlentin/harness/tool";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type DraftsApi, type DraftsContext, registerDrafts } from "../pi/drafts.ts";
import * as projectProtocol from "../src/protocol/project.ts";
import { Message, Person, Thread, ThreadMessages } from "../src/protocol/project.ts";
import * as requests from "../src/protocol/requests.ts";
import { send, setUp, startHost, tearDown } from "./helpers.ts";

const projects = { tool, protocol, projectProtocol, requests };

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** A new thread with two drafts out, A and B, with different texts. */
async function seedDrafts(topic: string): Promise<{ thread: Thread; a: Message; b: Message }> {
	const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }));
	const thread = Value.Parse(Thread, await send({ type: "thread", action: "add", topic, persons: [sam.id] }));

	const log = {
		type: "message",
		action: "log",
		caller: "cli",
		thread: thread.id,
		from: "user",
		direction: "out",
	} as const;

	const a = Value.Parse(Message, await send({ ...log, text: `The scope of ${topic}.\nIt holds two parts.` }));
	const b = Value.Parse(Message, await send({ ...log, text: `The rule of ${topic}.` }));

	return { thread, a, b };
}

async function states(thread: Thread): Promise<Record<number, string>> {
	const read = Value.Parse(ThreadMessages, await send({ type: "thread", action: "read", id: thread.id }));

	return Object.fromEntries(read.messages.map((message) => [message.id, message.state]));
}

/**
 * Runs `/drafts` with a UI that picks the option of `pick` and `copyText`, and gives the options of the pick and the
 * notifications.
 */
async function runDrafts(
	pick: Message,
	copyText: (text: string) => Promise<void>,
): Promise<{ options: string[]; notes: string[] }> {
	const handlers: ((args: string, ctx: DraftsContext) => Promise<void>)[] = [];
	const pi: DraftsApi = { registerCommand: (_name, command) => handlers.push(command.handler) };
	registerDrafts(pi, projects, copyText);
	const options: string[] = [];
	const notes: string[] = [];

	const ctx: DraftsContext = {
		mode: "tui",
		signal: undefined,
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			notify: (message, type) => notes.push(`${type ?? "info"}: ${message}`),
			select: async (_title, choices) => {
				options.push(...choices);

				return choices.find((choice) => choice.startsWith(`Draft ${pick.id}: `));
			},
		},
	};

	for (const handler of handlers) await handler("", ctx);

	return { options, notes };
}

describe("/drafts", { timeout: 30_000 }, () => {
	it("copies the picked draft and marks it sent, and leaves the other draft", async () => {
		const { thread, a, b } = await seedDrafts("Alpha");
		const copied: string[] = [];

		const { options, notes } = await runDrafts(a, async (text) => {
			copied.push(text);
		});

		expect(options).toEqual(
			expect.arrayContaining([`Draft ${a.id}: The scope of Alpha.`, `Draft ${b.id}: The rule of Alpha.`]),
		);

		expect(copied).toEqual([a.text]);

		expect(notes).toEqual(["info: Copied 2 lines: The scope of Alpha.", `info: Draft ${a.id} marked sent`]);

		expect(await states(thread)).toEqual({ [a.id]: "sent", [b.id]: "draft" });
	});

	it("keeps the copy when the mark fails, and warns with the error of the host", async () => {
		const { thread, a, b } = await seedDrafts("Beta");

		// The draft becomes sent between the read of `/drafts` and its mark.
		const { notes } = await runDrafts(a, async () => {
			await send({ type: "message", action: "mark", caller: "cli", message: a.id, state: "sent" });
		});

		expect(notes).toEqual([
			"info: Copied 2 lines: The scope of Beta.",
			`warning: Could not mark draft ${a.id} sent: Message ${a.id} is sent: it cannot become sent`,
		]);

		expect(await states(thread)).toEqual({ [a.id]: "sent", [b.id]: "draft" });
	});
});
