import type { Host } from "@vzlentin/harness/host";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Message, Person, Rule, RuleList, Thread } from "../src/protocol/project.ts";
import { projects, send, setUp, startHost, tearDown } from "./helpers.ts";

const USAGE_LINE = "  projects rule (decide | retire | delete) <id>\n";

let host: Host | undefined;

/** The ID of a new message of the user, which the open rules of the tests name as their source. */
async function sourceMessage(): Promise<number> {
	const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }));
	const thread = Value.Parse(Thread, await send({ type: "thread", action: "add", topic: "Rules", persons: [sam.id] }));

	const log = {
		type: "message",
		action: "log",
		caller: "cli",
		thread: thread.id,
		from: "user",
		direction: "in",
	} as const;

	return Value.Parse(Message, await send({ ...log, text: "The rules." })).id;
}

/** The rules of the host, as a request reads them. */
async function rules(): Promise<Rule[]> {
	return Value.Parse(RuleList, await send({ type: "rule", action: "list" })).rules;
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("projects rule", { timeout: 60_000 }, () => {
	it("lists, decides, edits, creates and deletes the rules as the user, and prints their lines", async () => {
		const source = await sourceMessage();
		const set = { type: "rule", action: "set", caller: "agent", saidBy: "user", source } as const;
		const rule = Value.Parse(Rule, await send({ ...set, name: "go", kind: "conduct", value: "Ask first." }));
		const said = `[said by user in message ${source}]`;

		expect(await projects(["rule"])).toEqual({
			code: 0,
			stdout: `${rule.id} go (conduct, open): Ask first. ${said}\n`,
			stderr: "",
		});

		// The CLI takes the action only right after `rule`.
		const early = await projects(["rule", "--kind", "domain", "edit", String(rule.id)]);
		expect(early).toMatchObject({ code: 1, stdout: "", stderr: expect.stringMatching(/^Usage:/) });
		expect(await rules()).toMatchObject([{ id: rule.id, kind: "conduct", status: "open" }]);

		expect(await projects(["rule", "decide", String(rule.id)])).toEqual({
			code: 0,
			stdout: `${rule.id} go (conduct, decided): Ask first. ${said}\n`,
			stderr: "",
		});

		// An edit of the user keeps the status, and makes the user its author with no source.
		expect(await projects(["rule", "edit", String(rule.id), "--value", "Newer."])).toEqual({
			code: 0,
			stdout: `${rule.id} go (conduct, decided): Newer. [said by user]\n`,
			stderr: "",
		});
		expect((await rules())[0]).not.toHaveProperty("source");

		const created = await projects(["rule", "create", "--name", "wait", "--kind", "domain", "--value", "Wait."]);
		const line = `${rule.id + 1} wait (domain, decided): Wait. [said by user]\n`;
		expect(created).toEqual({ code: 0, stdout: line, stderr: "" });
		expect(await projects(["rule", "list", "--kind", "domain", "--status", "decided"])).toEqual({
			code: 0,
			stdout: line,
			stderr: "",
		});

		expect(await projects(["rule", "delete", String(rule.id + 1)])).toMatchObject({ code: 0, stderr: "" });
		expect(await rules()).toMatchObject([{ id: rule.id, value: "Newer." }]);
		expect(await projects(["rule", "list", "--kind", "domain"])).toEqual({ code: 0, stdout: "No rules\n", stderr: "" });
	});

	it("refuses bad arguments with one line, and prints the usage for other words", async () => {
		const cases: [string[], string][] = [
			[["decide", "0"], "Invalid rule id: 0\n"],
			[["retire", "99"], "Unknown rule: 99\n"],
			[["list", "--kind", "law"], "Invalid rule kind: law\n"],
			[["list", "--status", "gone"], "Invalid rule status: gone\n"],
			[["list", "--verbose", "x"], "Unknown rule argument: --verbose\n"],
		];

		const results = await Promise.all(cases.map(([args]) => projects(["rule", ...args])));
		expect(results.map(({ code, stdout, stderr }) => ({ code, stdout, stderr }))).toEqual(
			cases.map(([, stderr]) => ({ code: 1, stdout: "", stderr })),
		);

		for (const args of [["--help"], ["move"], ["decide"], ["create", "--name", "x"], ["list", "--name", "x"]]) {
			const result = await projects(["rule", ...args]);
			expect(result).toMatchObject({ code: 1, stdout: "" });
			expect(result.stderr).toMatch(/^Usage:/);
			expect(result.stderr).toContain(USAGE_LINE);
		}
	});
});
