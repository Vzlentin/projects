#!/usr/bin/env node

import { request, requestEntry } from "@vzlentin/harness/client";
import { hostOf } from "@vzlentin/harness/hosts";
import {
	cliCaller,
	type EntryRequestLine,
	errorMessage,
	HARNESS_HOST,
	LocalId,
	ParleyAsks,
	type Request,
	RequestLine,
} from "@vzlentin/harness/protocol";
import type { Send, SendEntry } from "@vzlentin/harness/tool";
import { Value } from "typebox/value";
import { type ItemArgs, runItemTool, sendAskNote, sendRuleChange, sendRuleList } from "./project-tool.ts";
import { EdgeKind, ItemState } from "./protocol/item.ts";
import {
	parleyShowText,
	Rule,
	type RuleFilter,
	RuleKind,
	RuleStatus,
	type RuleUserChange,
} from "./protocol/project.ts";

function fail(message: string): never {
	throw new Error(message);
}

/** A command of the CLI: its lines in the usage, and what it runs. `host` is the `--host` value. */
type Command = {
	readonly usage: readonly string[];
	run(args: string[], host: string | undefined): Promise<void> | void;
};

function usage(): never {
	const lines = [...COMMANDS.values()].flatMap((command) => command.usage);

	fail(`Usage:
${lines.join("\n")}
Any command takes --host <name> before it; without it, the host is ${HARNESS_HOST}, then the cwd.`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];

	if (!value || value.startsWith("--")) fail(`${option} requires a value`);

	return value;
}

function itemId(value: string): number {
	const id = Number(value);

	if (!Value.Check(LocalId, id)) fail(`Invalid item id: ${value}`);

	return id;
}

/**
 * Sends a request to the host `host`, and starts the host when none runs: a request of a core type through `request`,
 * else a request of an entry through `requestEntry`.
 */
function hostSend(host: string | undefined): Send & SendEntry {
	const send = (message: Request | EntryRequestLine, signal: AbortSignal) =>
		Value.Check(RequestLine, message)
			? request(message, { start: true, signal, host })
			: requestEntry(message, { start: true, signal, host });

	// SAFETY: `request` gives the reply of the core type of the message, as `Send` says, and `requestEntry` gives the
	// JSON value of the reply of an entry, as `SendEntry` says.
	return send as Send & SendEntry;
}

/** The scope of a call of a project tool of the CLI, to the host `host`. The caller is `PI_SESSION_ID`, or `cli`. */
function cliScope(host: string | undefined) {
	return { caller: cliCaller(process.env), signal: undefined, send: hostSend(host) };
}

/**
 * Prints the parley `slug` of the host as Markdown: its frame, its asks with their answers, and its contract. With
 * `--json`, prints the reply of the host as one JSON line. With `note`, records the note of an ask for the caller, and
 * prints the line of the ask.
 */
async function parleyCommand(args: string[], host: string | undefined): Promise<void> {
	const [action, slug, flag] = args;

	if (action === "note") return noteCommand(args.slice(1), host);

	const json = flag === "--json";

	if (args.length !== (json ? 3 : 2) || action !== "show" || slug === undefined || slug.startsWith("--")) usage();
	const reply = await requestEntry({ type: "parley", action: "read", slug }, { start: true, host });

	if (!Value.Check(ParleyAsks, reply)) throw new Error("The host replied with no parley");
	process.stdout.write(json ? `${JSON.stringify(reply)}\n` : parleyShowText(reply));
}

/** Runs `parley note [<slug>] <ask> <note>`: the ask is its number in the parley `slug`, else its ID. */
async function noteCommand(args: string[], host: string | undefined): Promise<void> {
	if (args.length !== 2 && args.length !== 3) usage();
	const [slug, value, note] = args.length === 3 ? args : [undefined, ...args];

	if (value === undefined || note === undefined) usage();
	const n = Number(value);

	if (!Value.Check(LocalId, n)) fail(`Invalid ask: ${value}`);
	const { text } = await sendAskNote(slug, n, note, cliScope(host));

	process.stdout.write(text);
}

/** The options of a command after its action, by name, and the words that are not options. */
type CommandOptions = { readonly words: readonly string[]; readonly options: ReadonlyMap<string, string> };

/** The options of `command` in `args`, each one of `known` at most once, and the words that are not options. */
function commandOptions(command: string, known: readonly string[], args: string[]): CommandOptions {
	const words: string[] = [];
	const options = new Map<string, string>();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";

		if (!arg.startsWith("--")) {
			words.push(arg);
			continue;
		}

		if (!known.includes(arg) || options.has(arg)) fail(`Unknown ${command} argument: ${arg}`);
		options.set(arg, valueAfter(args, i, arg));
		i++;
	}

	return { words, options };
}

/** Prints the usage when `options` has an option that is not one of `allowed`. */
function onlyOptions(options: CommandOptions["options"], allowed: readonly string[]): void {
	if ([...options.keys()].some((option) => !allowed.includes(option))) usage();
}

function ruleId(value: string | undefined): number {
	const id = Number(value);

	if (!Value.Check(Rule.properties.id, id)) fail(`Invalid rule id: ${value}`);

	return id;
}

function ruleKind(value: string | undefined): RuleKind | undefined {
	if (value !== undefined && !Value.Check(RuleKind, value)) fail(`Invalid rule kind: ${value}`);

	return value;
}

function ruleStatus(value: string | undefined): RuleStatus | undefined {
	if (value !== undefined && !Value.Check(RuleStatus, value)) fail(`Invalid rule status: ${value}`);

	return value;
}

/**
 * The change of a rule by the user from the arguments of `rule`, or the filter of `rule list`. The action is the first
 * argument, `list` when there is none, and the options come after it.
 */
function ruleArgs(args: string[]): RuleUserChange | { readonly action: "list"; readonly filter: RuleFilter } {
	const [action = "list", ...after] = args;
	const { words: rest, options } = commandOptions("rule", ["--name", "--kind", "--value", "--status"], after);

	switch (action) {
		case "list": {
			onlyOptions(options, ["--kind", "--status"]);

			if (rest.length !== 0) usage();
			const kind = ruleKind(options.get("--kind"));
			const status = ruleStatus(options.get("--status"));

			return { action, filter: { ...(kind && { kind }), ...(status && { status }) } };
		}

		case "decide":
		case "retire":
		case "delete":
			onlyOptions(options, []);

			if (rest.length !== 1) usage();

			return { action, id: ruleId(rest[0]) };
		case "edit": {
			onlyOptions(options, ["--name", "--kind", "--value"]);

			if (rest.length !== 1) usage();
			const name = options.get("--name");
			const kind = ruleKind(options.get("--kind"));
			const value = options.get("--value");

			return { action, id: ruleId(rest[0]), ...(name && { name }), ...(kind && { kind }), ...(value && { value }) };
		}

		case "create": {
			onlyOptions(options, ["--name", "--kind", "--value"]);
			const name = options.get("--name");
			const kind = ruleKind(options.get("--kind"));
			const value = options.get("--value");

			if (rest.length !== 0 || name === undefined || kind === undefined || value === undefined) usage();

			return { action, name, kind, value };
		}

		default:
			usage();
	}
}

/** Lists the rules of the host, or makes a change of a rule as the user, and prints the lines. */
async function ruleCommand(args: string[], host: string | undefined): Promise<void> {
	const call = ruleArgs(args);
	const scope = cliScope(host);

	const { text } = call.action === "list" ? await sendRuleList(call.filter, scope) : await sendRuleChange(call, scope);

	process.stdout.write(text);
}

function itemState(value: string): ItemState {
	if (!Value.Check(ItemState, value)) fail(`Invalid item state: ${value}`);

	return value;
}

function edgeKind(value: string): EdgeKind {
	if (!Value.Check(EdgeKind, value)) fail(`Invalid edge kind: ${value}`);

	return value;
}

/**
 * The call of the `item` tool from the arguments of `item`. The action is the first argument, `list` when there is
 * none, and the options come after it.
 */
function itemArgs(args: string[]): ItemArgs {
	const [action = "list", ...after] = args;
	const { words: rest, options } = commandOptions("item", ["--state", "--title", "--text"], after);
	const text = options.get("--text");

	switch (action) {
		case "list": {
			onlyOptions(options, ["--state"]);

			if (rest.length !== 0) usage();
			const state = options.get("--state");

			return state === undefined ? { action } : { action, state: itemState(state) };
		}

		case "add": {
			onlyOptions(options, ["--text"]);

			if (rest.length === 0) usage();
			const add = { action, title: rest.join(" ") } as const;

			return text === undefined ? add : { ...add, text };
		}

		case "set": {
			onlyOptions(options, ["--title", "--text"]);
			const [id, state, ...extra] = rest;

			if (id === undefined || extra.length !== 0 || (state === undefined && options.size === 0)) usage();
			let call: ItemArgs = { action, id: itemId(id) };
			const title = options.get("--title");

			if (state !== undefined) call = { ...call, state: itemState(state) };

			if (title !== undefined) call = { ...call, title };

			return text === undefined ? call : { ...call, text };
		}

		case "show": {
			onlyOptions(options, []);
			const [id] = rest;

			if (rest.length !== 1 || id === undefined) usage();

			return { action: "read", id: itemId(id) };
		}

		case "link": {
			onlyOptions(options, []);
			const [from, kind, to] = rest;

			if (rest.length !== 3 || from === undefined || kind === undefined || to === undefined) usage();

			return { action, from, kind: edgeKind(kind), to };
		}

		default:
			usage();
	}
}

/** Runs `item` as a call of the `item` tool, and prints its output. */
async function itemCommand(args: string[], host: string | undefined): Promise<void> {
	const { text } = await runItemTool(itemArgs(args), cliScope(host));

	process.stdout.write(text);
}

/**
 * Loads the project lists of a store file into the empty project store of the host while no host runs, and prints the
 * count of each list. A file with asks or todos fails.
 */
async function storeCommand(args: string[], host: string | undefined): Promise<void> {
	const [action, file, ...rest] = args;

	if (action !== "load" || file === undefined || rest.length !== 0) usage();
	const name = hostOf(host, process.env, process.cwd());
	// Only `store load` opens the project store, so the other commands do not load it.
	const { loadStore } = await import("./projects/store-load.ts");
	const counts = await loadStore(name, file);

	for (const [key, count] of Object.entries(counts)) process.stdout.write(`${key}: ${count}\n`);
}

/** The commands of the CLI, in the order of the usage. */
const COMMANDS: ReadonlyMap<string, Command> = new Map(
	Object.entries({
		parley: {
			usage: ["  projects parley show <slug> [--json]", "  projects parley note [<slug>] <ask> <note>"],
			run: parleyCommand,
		},
		rule: {
			usage: [
				"  projects rule [list [--kind <kind>] [--status <status>]]",
				"  projects rule (decide | retire | delete) <id>",
				"  projects rule edit <id> [--name <name>] [--kind <kind>] [--value <text>]",
				"  projects rule create --name <name> --kind <kind> --value <text>",
			],
			run: ruleCommand,
		},
		item: {
			usage: [
				"  projects item [list [--state <state>]]",
				"  projects item add <title> [--text <text>]",
				"  projects item set <id> [<state>] [--title <title>] [--text <text>]",
				"  projects item show <id>",
				"  projects item link <from> <kind> <to>",
			],
			run: itemCommand,
		},
		store: {
			usage: ["  projects store load <file>   loads the project lists; refuses a file with asks or todos"],
			run: storeCommand,
		},
	} satisfies Record<string, Command>),
);

/** Runs a command of the table. Any other word gives the usage. */
async function main(): Promise<void> {
	const all = process.argv.slice(2);
	// Only before the command, so a title or a note can contain the word.
	let host: string | undefined;

	if (all[0] === "--project") fail("projects takes --host <name>, not --project");

	if (all[0] === "--host") {
		host = valueAfter(all, 0, "--host");
		all.splice(0, 2);
	}

	const [command, ...args] = all;
	const known = command === undefined ? undefined : COMMANDS.get(command);

	if (known === undefined) usage();

	return known.run(args, host);
}

main().catch((cause: unknown) => {
	process.stderr.write(`${errorMessage(cause)}\n`);
	process.exitCode = 1;
});
