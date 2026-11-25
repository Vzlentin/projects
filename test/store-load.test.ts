import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setEntry } from "@vzlentin/harness/entries";
import { AGENT_HANDLE, statePaths } from "@vzlentin/harness/protocol";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ProjectStore } from "../src/projects/project-store.ts";
import { Message, Person, Rule, Thread } from "../src/protocol/project.ts";
import { StoreFile } from "../src/protocol/store-file.ts";
import {
	createHost,
	OPTIONS,
	PROJECTS_FIXTURE,
	projects,
	readStores,
	root,
	send,
	setUp,
	startHost,
	tearDown,
} from "./helpers.ts";

/** Starts the host `host`, stops it, and gives the lists of its stores. */
async function hostedFile(host: string): Promise<StoreFile> {
	const started = await startHost(host);
	await started.close();

	return readStores(host);
}

/** Runs `projects store load <path>` for the host `host`. */
function load(host: string, path: string) {
	return projects(["--host", host, "store", "load", path]);
}

/** Fills each list of the store of the host `host`, which runs. */
async function fill(host: string): Promise<void> {
	const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, host));
	const kim = Value.Parse(Person, await send({ type: "person", action: "add", name: "Kim" }, host));

	const threadOf = async (topic: string, persons: number[]) =>
		Value.Parse(Thread, await send({ type: "thread", action: "add", topic, persons }, host));

	const log = async (thread: number, from: number | "user", direction: "in" | "out", at: number, text: string) =>
		Value.Parse(
			Message,
			await send({ type: "message", action: "log", caller: "cli", thread, from, direction, at, text }, host),
		);

	const scope = await threadOf("Scope", [sam.id]);
	const asked = await log(scope.id, "user", "out", 1_000, "Which sale types?");
	await send({ type: "message", action: "mark", caller: "cli", message: asked.id, state: "sent" }, host);
	await log(scope.id, sam.id, "in", 2_000, "Only retail.");
	const dates = await threadOf("Dates", [kim.id, sam.id]);
	const sent = await log(dates.id, "user", "out", 3_000, "When?");
	const dropped = await log(dates.id, "user", "out", 4_000, "Never mind.");
	await log(dates.id, "user", "out", 5_000, "Still a draft.");
	await send({ type: "message", action: "mark", caller: "cli", message: sent.id, state: "sent" }, host);
	await send({ type: "message", action: "mark", caller: "cli", message: dropped.id, state: "dropped" }, host);

	const rule = (name: string, source: number) =>
		send(
			{
				type: "rule",
				action: "set",
				caller: "cli",
				saidBy: sam.id,
				source,
				name,
				kind: "conduct",
				value: `${name} first.`,
			},
			host,
		);

	await rule("ask", asked.id);
	const gone = Value.Parse(Rule, await rule("wait", sent.id));
	await send({ type: "rule", action: "delete", caller: "cli", id: gone.id }, host);

	await send(
		{
			type: "ask",
			action: "round",
			caller: "pi-1",
			parley: { slug: "where", title: "Where asks live", goal: "Pick the place.", design_sense: "One writer." },
			asks: [{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
		},
		host,
	);

	await send({ type: "todo", action: "add", caller: "cli", handle: AGENT_HANDLE, text: "Plan" }, host);
	await send({ type: "todo", action: "add", caller: "session-a", text: "Review" }, host);
}

beforeAll(async () => {
	await setUp();
	// `readStores` reads the asks and the todos with the handles of the fixture entry.
	setEntry("projects", PROJECTS_FIXTURE);
});

afterAll(async () => {
	await tearDown();
});

describe("projects store load", { timeout: 60_000 }, () => {
	it("loads a store file into an empty store, keeps the IDs of threads, messages and rules, and refuses what it cannot load", async () => {
		await createHost("load-source");
		await createHost("load-target");
		await createHost("load-new");
		const empty = await hostedFile("load-target");
		expect(empty).toMatchObject({ persons: [], threads: [], rules: [] });

		const host = await startHost("load-source");

		try {
			await fill("load-source");
		} finally {
			await host.close();
		}

		const hosted = await readStores("load-source");
		expect(hosted.asks).toHaveLength(2);
		expect(hosted.todos).toHaveLength(1);
		expect(hosted.callerTodos.map((list) => list.todos.length)).toEqual([1]);
		// The asks and the todos belong to the harness host, so the loaded file has only the project lists.
		const source: StoreFile = { ...hosted, asks: [], todos: [], callerTodos: [] };

		expect(source.lastRule).toBeGreaterThan(source.rules.at(-1)?.id ?? 0);
		expect(source.rules.map((rule) => rule.thread)).toEqual([source.threads[0]?.id]);
		const outs = source.threads.flatMap((thread) => thread.messages.filter((message) => message.direction === "out"));
		expect(outs.map((out) => out.state).sort()).toEqual(["answered", "draft", "dropped", "sent"]);
		const path = join(root, "load-source.json");
		await writeFile(path, JSON.stringify(source));

		// Into a store whose root conversation exists.
		expect(await load("load-target", path)).toMatchObject({ code: 0, stderr: "" });
		const loaded = await hostedFile("load-target");
		expect(loaded).toEqual(source);

		// Into a store that never had a host.
		expect(await load("load-new", path)).toEqual({
			code: 0,
			stdout: "persons: 2\nthreads: 2\nmessages: 5\nrules: 1\nparleys: 1\noutbox: 4\nitems: 0\n",
			stderr: "",
		});

		expect(await hostedFile("load-new")).toEqual(source);

		// A rule that an older file gives with a source and no thread gets the thread of its source message.
		await createHost("load-old");
		const old = join(root, "load-old.json");
		const oldRules = source.rules.map((rule) => ({ ...rule, thread: undefined }));
		await writeFile(old, JSON.stringify({ ...source, rules: oldRules }));
		expect(await load("load-old", old)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("load-old")).toEqual(source);

		// A store that is not empty stays as it is.
		expect(await load("load-target", path)).toEqual({
			code: 1,
			stdout: "",
			stderr: "The store of load-target is not empty: projects store load writes only into an empty store\n",
		});

		expect(await hostedFile("load-target")).toEqual(loaded);

		// A running host keeps the lock, and its lists stay as they are.
		const running = await startHost("load-target");

		try {
			expect(await load("load-target", path)).toEqual({
				code: 1,
				stdout: "",
				stderr: "A harness host runs for load-target: stop it, then run projects store load again\n",
			});

			expect(await send({ type: "person", action: "list" }, "load-target")).toEqual({ persons: source.persons });
		} finally {
			await running.close();
		}
	});

	it("writes into an empty project.sqlite, which keeps its ID counters", async () => {
		await createHost("load-used");
		const { dir } = statePaths("load-used");
		await hostedFile("load-used");
		const rule = { name: "a", kind: "conduct", value: "A.", status: "open", saidBy: "user", at: 1, by: "cli" } as const;
		const used = ProjectStore.open(dir, 0);

		try {
			used.write((tx) => {
				for (let n = 0; n < 3; n++) tx.removeRule(tx.addRule(rule).id);
			});
		} finally {
			used.close();
		}

		const path = join(root, "load-used.json");
		await writeFile(path, JSON.stringify(Value.Create(StoreFile)));
		expect(await load("load-used", path)).toMatchObject({ code: 0, stderr: "" });
		const loaded = ProjectStore.open(dir, 0);

		try {
			expect(loaded.lastRule()).toBe(3);
			expect(loaded.write((tx) => tx.addRule(rule)).id).toBe(4);
		} finally {
			loaded.close();
		}
	});

	it("keeps the edits and deletes of messages in a store file, which loads", async () => {
		await createHost("edit-source");
		await createHost("edit-target");
		const host = await startHost("edit-source");
		let draft: Message;
		let rule: Rule;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, "edit-source"));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, "edit-source"),
			);

			const log = async (from: number | "user", direction: "in" | "out", at: number, text: string) =>
				Value.Parse(
					Message,
					await send(
						{ type: "message", action: "log", caller: "cli", thread: thread.id, from, direction, at, text },
						"edit-source",
					),
				);

			const written = await log("user", "out", 1_000, "Which types?");
			// An earlier message in moves no draft.
			const asked = await log(sam.id, "in", 500, "Only retail.");
			const edit = { type: "message", action: "edit", caller: "cli", message: written.id } as const;
			draft = Value.Parse(Message, await send({ ...edit, text: "Which sale types?", at: 3_000 }, "edit-source"));

			const set = {
				type: "rule",
				action: "set",
				caller: "cli",
				saidBy: sam.id,
				source: asked.id,
				name: "retail",
				kind: "domain",
				value: "Only retail.",
			} as const;

			const added = Value.Parse(Rule, await send(set, "edit-source"));
			rule = Value.Parse(
				Rule,
				await send({ type: "rule", action: "retire", caller: "user", id: added.id }, "edit-source"),
			);
			await send({ type: "message", action: "delete", caller: "cli", message: asked.id }, "edit-source");
		} finally {
			await host.close();
		}

		const source = await readStores("edit-source");
		const { source: _source, thread: _thread, ...unsourced } = rule;
		const { state, by, thread: _of, ...message } = draft;
		expect(source.rules).toEqual([unsourced]);

		expect(source.threads).toEqual([
			{
				id: draft.thread,
				topic: "Scope",
				persons: [1],
				last: 3_000,
				messages: [{ ...message, thread: draft.thread, by, state, changed: { at: 1_000, by: "cli" } }],
			},
		]);

		const path = join(root, "edit-source.json");
		await writeFile(path, JSON.stringify(source));
		expect(await load("edit-target", path)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("edit-target")).toEqual(source);
	});

	it("refuses a file with asks or todos before it writes", async () => {
		await createHost("asks-source");
		await createHost("asks-target");
		const host = await startHost("asks-source");

		try {
			await fill("asks-source");
		} finally {
			await host.close();
		}

		const hosted = await readStores("asks-source");
		const { dir } = statePaths("asks-target");
		const empty = Value.Create(StoreFile);
		const todo = { id: 1, text: "Plan", state: "open" } as const;

		const files = [
			["asks.json", { ...hosted, todos: [], callerTodos: [] }],
			["todos.json", { ...empty, todos: [todo] }],
			["caller-todos.json", { ...empty, callerTodos: [{ caller: "session-a", todos: [todo] }] }],
			["all.json", hosted],
		] as const;

		for (const [name, file] of files) {
			const path = join(root, name);
			await writeFile(path, JSON.stringify(file));

			expect(await load("asks-target", path)).toEqual({
				code: 1,
				stdout: "",
				stderr: `${path} has asks or todos: they belong to the harness host, and projects store load does not load them\n`,
			});

			expect(existsSync(join(dir, "project.sqlite"))).toBe(false);
			expect(existsSync(join(dir, "durable.sqlite"))).toBe(false);
		}

		// A caller with an empty list of todos loads.
		const path = join(root, "empty-caller.json");
		await writeFile(path, JSON.stringify({ ...empty, callerTodos: [{ caller: "session-a", todos: [] }] }));
		expect(await load("asks-target", path)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("asks-target")).toMatchObject({ asks: [], todos: [], callerTodos: [] });
	});

	it("leaves no project.sqlite and no project.sqlite.import when the write into a new store fails", async () => {
		await createHost("load-unique");
		const { dir } = statePaths("load-unique");
		const parley = { id: 1, slug: "where", title: "Where", goal: "Pick.", status: "open", at: 1, by: "pi-1" } as const;
		// The parse takes the file, and the UNIQUE slug of project.sqlite refuses it.
		const path = join(root, "load-unique.json");
		await writeFile(path, JSON.stringify({ ...Value.Create(StoreFile), parleys: [parley, { ...parley, id: 2 }] }));

		const failed = await load("load-unique", path);
		expect(failed).toMatchObject({ code: 1, stdout: "" });
		expect(failed.stderr).toContain("UNIQUE");
		expect(existsSync(join(dir, "project.sqlite"))).toBe(false);
		expect(existsSync(join(dir, "project.sqlite.import"))).toBe(false);
	});

	it("loads a file with its items, and the counter takes the highest ID of the items", async () => {
		await createHost("load-items");
		const lists = Value.Create(StoreFile);

		const edge = { from: "agent:7", kind: "serves", to: "item:2", at: 5, by: "cli" } as const;
		const needs = { from: "item:3", kind: "needs", to: "item:2", at: 6, by: "cli" } as const;

		const items = [
			{ id: 2, title: "Two", state: "open", edges: [edge], at: 5, by: "cli" },
			{ id: 3, title: "Three", state: "open", edges: [needs], at: 6, by: "cli" },
		] as const;

		const path = join(root, "load-items.json");
		await writeFile(path, JSON.stringify({ ...lists, items, lastItem: 1 }));
		expect(await load("load-items", path)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("load-items")).toMatchObject({ items, lastItem: 3 });

		const host = await startHost("load-items");

		try {
			expect(await send({ type: "item", action: "add", caller: "cli", title: "Next" }, "load-items")).toMatchObject({
				id: 4,
			});
			expect(await send({ type: "item", action: "read", id: 2 }, "load-items")).toMatchObject({
				edges: [edge, needs],
			});
		} finally {
			await host.close();
		}
	});

	it("refuses a file that is not a store file before it opens the store", async () => {
		await createHost("load-refused");
		const store = join(statePaths("load-refused").dir, "durable.sqlite");
		const base = Value.Create(StoreFile);

		const changed = { at: 1, by: "cli" };
		const fields = { id: 9, thread: 3, from: "user", state: "draft", at: 1, text: "Hi", by: "cli" };
		const message = { ...fields, direction: "out", changed };
		const thread = { id: 3, topic: "Scope", persons: [1], messages: [message] };

		const cases = [
			["not-json.json", "{", "not-json.json is not a store file: "],
			[
				"version-1.json",
				JSON.stringify({ ...base, version: 1 }),
				"has the version 1: projects store load reads only the version 3",
			],
			[
				"version-2.json",
				JSON.stringify({ ...base, version: 2 }),
				"has the version 2: projects store load reads only the version 3",
			],
			["schema.json", JSON.stringify({ ...base, persons: [{ id: 1 }] }), "is not a store file: /persons/0"],
			[
				"no-change.json",
				JSON.stringify({ ...base, threads: [{ ...thread, messages: [fields] }] }),
				"is not a store file: /threads/0/messages/0",
			],
			[
				"change-in.json",
				JSON.stringify({
					...base,
					threads: [{ ...thread, messages: [{ ...fields, direction: "in", state: "received", changed }] }],
				}),
				"is not a store file: /threads/0/messages/0",
			],
			[
				"other-thread.json",
				JSON.stringify({ ...base, threads: [{ ...thread, messages: [{ ...message, thread: 4 }] }] }),
				"is not a store file: message 9 names the thread 4, not 3",
			],
			[
				"source.json",
				JSON.stringify({
					...base,
					threads: [thread],
					rules: [
						{
							id: 1,
							name: "a",
							kind: "conduct",
							value: "A.",
							status: "open",
							saidBy: "user",
							source: 8,
							at: 1,
							by: "cli",
						},
					],
					lastRule: 1,
				}),
				"is not a store file: the source of the rule 1 is no message of the file",
			],
		] as const;

		for (const [name, text, line] of cases) {
			const path = join(root, name);
			await writeFile(path, text);
			const result = await load("load-refused", path);
			expect(result).toMatchObject({ code: 1, stdout: "" });
			expect(result.stderr).toContain(line);
			expect(result.stderr.startsWith(path)).toBe(true);
			expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
			expect(existsSync(store)).toBe(false);
		}

		const todo = (id: number) => ({ id, text: "Plan", state: "open" });
		const edge = { from: "agent:7", kind: "serves", to: "item:2", at: 1, by: "cli" };
		const needs = { from: "item:2", kind: "needs", to: "item:1", at: 1, by: "cli" };

		const item = (id: number, edges: readonly object[]) => ({
			id,
			title: "Ship",
			state: "open",
			edges,
			at: 1,
			by: "cli",
		});

		const twice = { ...base, threads: [thread] };

		const exact = [
			[
				"same-message.json",
				{
					...base,
					threads: [
						{ ...thread, id: 5, messages: [{ ...message, id: 10, thread: 5 }] },
						{ ...thread, id: 6, messages: [{ ...message, id: 10, thread: 6 }] },
					],
				},
				"the messages have the ID 10 twice",
			],
			[
				"same-thread.json",
				{ ...base, threads: [thread, { ...thread, messages: [] }] },
				"the threads have the ID 3 twice",
			],
			[
				"same-person.json",
				{
					...twice,
					persons: [
						{ id: 1, name: "Sam" },
						{ id: 1, name: "Kim" },
					],
				},
				"the persons have the ID 1 twice",
			],
			["same-todo.json", { ...twice, todos: [todo(1), todo(1)] }, "the todos have the ID 1 twice"],
			[
				"same-caller-todo.json",
				{ ...twice, callerTodos: [{ caller: "session-a", todos: [todo(2), todo(2)] }] },
				"the todos of session-a have the ID 2 twice",
			],
			[
				"same-caller.json",
				{
					...twice,
					callerTodos: [
						{ caller: "session-a", todos: [todo(1)] },
						{ caller: "session-a", todos: [todo(1)] },
					],
				},
				"callerTodos has the caller session-a twice",
			],
			["todo-ask.json", { ...twice, todos: [{ ...todo(1), ask: 4 }] }, "the ask of the todo 1 is no ask of the file"],
			[
				"caller-todo-ask.json",
				{ ...twice, callerTodos: [{ caller: "session-a", todos: [todo(1), { ...todo(2), ask: 4 }] }] },
				"the ask of the todo 2 of session-a is no ask of the file",
			],
			["same-item.json", { ...twice, items: [item(2, []), item(2, [])], lastItem: 2 }, "the items have the ID 2 twice"],
			[
				"other-item.json",
				{ ...twice, items: [item(2, [{ ...edge, to: "item:3" }])], lastItem: 3 },
				"the edge agent:7 serves item:3 is not an edge of the item 2",
			],
			[
				"edge-ends.json",
				{ ...twice, items: [item(2, [{ ...edge, kind: "landed" }])], lastItem: 2 },
				"the edge agent:7 landed item:2 is not an edge of the item 2",
			],
			[
				"needs-on-to.json",
				{ ...twice, items: [item(2, [{ ...edge, from: "item:1", kind: "needs" }])], lastItem: 2 },
				"the edge item:1 needs item:2 is not an edge of the item 2",
			],
			[
				"needs-unknown.json",
				{ ...twice, items: [item(2, [{ ...needs, to: "item:99" }])], lastItem: 2 },
				"the edge item:2 needs item:99 goes to no item of the file",
			],
			[
				"needs-cycle.json",
				{
					...twice,
					items: [
						item(1, [{ ...needs, from: "item:1", to: "item:2" }]),
						item(2, [needs]),
						item(3, [{ ...needs, from: "item:3", to: "item:2" }]),
					],
					lastItem: 3,
				},
				"the needs edges make a cycle through the item 1",
			],
			[
				"needs-self.json",
				{ ...twice, items: [item(2, [{ ...needs, to: "item:2" }])], lastItem: 2 },
				"the needs edges make a cycle through the item 2",
			],
		] as const;

		for (const [name, file, reason] of exact) {
			const path = join(root, name);
			await writeFile(path, JSON.stringify(file));

			expect(await load("load-refused", path)).toEqual({
				code: 1,
				stdout: "",
				stderr: `${path} is not a store file: ${reason}\n`,
			});

			expect(existsSync(store)).toBe(false);
		}
	});
});
