import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import {
	type AssistantMessage,
	getSystemMessageText,
	type Message,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderState,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	type ConversationView,
	createRegistry,
	type Extension,
	Harness,
	ROOT_CONVERSATION_ID,
	type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Client, connect, request, requestEntry } from "@vzlentin/harness/client";
import { setEntry } from "@vzlentin/harness/entries";
import { EntryLine } from "@vzlentin/harness/entry-api";
import { type Host, runHost } from "@vzlentin/harness/host";
import { hostDir, MAIN_HOST } from "@vzlentin/harness/hosts";
import {
	AGENT_HANDLE,
	AskWrite,
	type ChildInfo,
	type EntryRequestLine,
	onLines,
	ParleyAsks,
	type Replies,
	type Request,
	RequestLine,
	type SpawnServes,
	statePaths,
	type Target,
	type WatchLine,
} from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, vi } from "vite-plus/test";
import { PROJECT_STORE_FILE, ProjectStore } from "../src/projects/project-store.ts";
import { readStoreFile } from "../src/projects/store-file.ts";
import { ItemList } from "../src/protocol/item.ts";
import { ProjectEvent, ProjectState } from "../src/protocol/project-watch.ts";
import type { ProjectRequest, Replies as ProjectReplies } from "../src/protocol/requests.ts";
import type { StoreFile } from "../src/protocol/store-file.ts";
import { fixtureHandles } from "./fixtures/projects.ts";

/** The CLI of the installed harness, which the tests run for `create`, `spawn` and `wait`. */
export const CLI = fileURLToPath(new URL("dist/cli.js", import.meta.resolve("@vzlentin/harness/package.json")));

/** The CLI of this checkout, which Node runs from source with type stripping, so a test needs no fresh build. */
export const PROJECTS_CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export let root: string;

/** One model request: what the faux provider saw. */
type Call = {
	readonly provider: string;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly prompt: string;
};

export const calls: Call[] = [];

/** The texts of the user messages of the last request for each prompt, in order. */
export const contexts = new Map<string, string[]>();

/**
 * The system prompt and the tools of the last request for each prompt: their names, their full declarations, and the
 * sections that the model has, from all the system messages of the request in order.
 */
export const requests = new Map<
	string,
	{
		readonly system: string;
		readonly tools: readonly string[];
		readonly declarations: readonly Tool[];
		readonly sections: Readonly<Record<string, string>>;
	}
>();

/** Requests that wait for a test to release them, by prompt. */
export const gates = new Map<string, PromiseWithResolvers<void>>();

export const models = createModels();
const environment = { ...process.env };

function textOf(message: Message): string {
	if (message.role === "system") return "";
	const { content } = message;

	if (!Array.isArray(content)) return content;

	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The sections that the model has after `messages`: each system message sets a section, or removes it with `null`. */
function replayedSections(messages: readonly Message[]) {
	const sections: Record<string, string> = {};

	for (const message of messages) {
		if (message.role !== "system") continue;

		for (const [name, text] of Object.entries(message.sections ?? {})) {
			if (text === null) delete sections[name];
			else sections[name] = text;
		}
	}

	return sections;
}

/** One tool call of the model: the name of the tool and its arguments. */
type ScriptedCall = { readonly name: string; readonly arguments: ToolCall["arguments"] };

/** One round of the model: one tool call, or the tool calls of one message. */
type ScriptStep = ScriptedCall | readonly ScriptedCall[];

/**
 * The tool calls that the model of a prompt makes, one step in each round, by prompt. After the last one, it answers
 * `Tool said: <result>`.
 */
export const scripts = new Map<string, readonly ScriptStep[]>();

/** The text of each tool result of the current turn of a prompt of `scripts`, by prompt. */
export const cellResults = new Map<string, string[]>();

async function respond(
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	_state: FauxProviderState,
	model: { readonly id: string; readonly provider: string },
): Promise<AssistantMessage> {
	const messages = context.messages.filter((message) => message.role !== "system");
	const last = messages.at(-1);
	const lastUser = messages.findLast((message) => message.role === "user");
	const prompt = lastUser === undefined ? "" : textOf(lastUser);
	// Only the tool results of this turn count: the host agent keeps the turns before.
	const turn = lastUser === undefined ? messages : messages.slice(messages.indexOf(lastUser) + 1);

	const script = scripts.get(prompt);

	if (script !== undefined && last?.role === "toolResult") {
		const done = turn.flatMap((message) => (message.role === "toolResult" ? [textOf(message)] : []));
		cellResults.set(prompt, done);
		const rounds = turn.filter((message) => message.role === "assistant" && message.stopReason === "toolUse");
		const next = script[rounds.length];

		if (next !== undefined) return stepMessage(next);
	}

	if (last?.role === "toolResult") {
		return fauxAssistantMessage(`Tool said: ${textOf(last)}`);
	}

	calls.push({ provider: model.provider, model: model.id, thinking: options?.reasoning, prompt });
	contexts.set(
		prompt,
		messages.flatMap((message) => (message.role === "user" ? [textOf(message)] : [])),
	);
	const [system] = context.messages;

	if (system?.role === "system") {
		requests.set(prompt, {
			system: getSystemMessageText(system),
			tools: (system.toolsAdded ?? []).map(({ name }) => name),
			declarations: system.toolsAdded ?? [],
			sections: replayedSections(context.messages),
		});
	}

	const gate = gates.get(prompt);

	if (gate !== undefined) {
		await Promise.race([
			gate.promise,
			new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		]);
	}

	const [first] = script ?? [];

	if (first !== undefined) {
		cellResults.set(prompt, []);

		return stepMessage(first);
	}

	const readPath = /^(?:Task:\n)?Read (.+)$/.exec(prompt)?.[1];

	if (readPath !== undefined) {
		return fauxAssistantMessage(fauxToolCall("read", { path: readPath }), { stopReason: "toolUse" });
	}

	if (prompt === "Task:\nEnvironment") {
		const command = 'echo "$PI_SESSION_ID $PI_PROVIDER $PI_MODEL $PI_REASONING_LEVEL $HARNESS_HOST"';

		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	}

	return fauxAssistantMessage(`Answer to ${prompt}`);
}

/** The message of the model for the step `step`: its tool calls, in one message. */
function stepMessage(step: ScriptStep): AssistantMessage {
	const calls = "name" in step ? [step] : step;

	return fauxAssistantMessage(
		calls.map((call) => fauxToolCall(call.name, call.arguments)),
		{ stopReason: "toolUse" },
	);
}

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs the CLI of the installed harness with `args` as a real process, in `cwd`, with `env` over the test environment. */
export function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd = root): Promise<Result> {
	return run(CLI, args, env, cwd);
}

/** Runs the `projects` CLI of this checkout with `args` as a real process, in `cwd`, with `env` over the test environment. */
export function projects(args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd = root): Promise<Result> {
	return run(PROJECTS_CLI, args, env, cwd);
}

/** Runs the script `script` with `args` as a real Node process, in `cwd`, with `env` over the test environment. */
function run(script: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Result> {
	return new Promise((resolve) => {
		execFile(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
			// `code` is the exit code, or a string such as `ENOENT` when the process did not start.
			const code = error === null ? 0 : Number.isInteger(error.code) ? Number(error.code) : 1;
			resolve({ code, stdout, stderr });
		});
	});
}

/** The handle in `Spawned <handle>` or `Spawned <name> (<handle>)`. */
export function handleOf(result: Result): string {
	const handle = /^Spawned (?:.* \()?([a-z0-9]+)\)?$/m.exec(result.stdout)?.[1];

	if (handle === undefined) throw new Error(`no handle in ${JSON.stringify(result)}`);

	return handle;
}

/**
 * Runs the host `name` in this process. It throws when another host has the lock, such as one that a CLI started
 * while the test host was down, because the tests would then run against a host without the faux provider.
 */
export async function startHost(name = MAIN_HOST): Promise<Host> {
	const host = await runHost({ host: name, cwd: hostDir(name), models });

	if (host === undefined) throw new Error(`another host has the lock of ${name}`);

	return host;
}

/** Adds the host `name` with a new directory, and gives the directory. */
export async function createHost(name: string): Promise<string> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);

	return dir;
}

/** Adds the host `name` with a new directory, and runs its host in this process. */
export async function newHost(name: string): Promise<Host> {
	await createHost(name);

	return startHost(name);
}

/**
 * The lists of the two stores of the host `host` as a store file, as a program reads them while no host writes: the
 * lists of `project.sqlite`, empty when it does not exist, and of `durable.sqlite`, with the asks and the todos handles
 * of the last host that loaded the projects fixture entry.
 */
export async function readStores(host: string): Promise<StoreFile> {
	const { dir } = statePaths(host);
	const storage = await openNodeSqliteStorage(join(dir, "durable.sqlite"));

	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry: createRegistry(), readOnly: true },
		BACKGROUND_CONTEXT,
	);

	const store = existsSync(join(dir, PROJECT_STORE_FILE)) ? ProjectStore.open(dir, 5_000) : undefined;
	const { asks, todos } = fixtureHandles();

	try {
		return await readStoreFile(harness, storage, ROOT_CONVERSATION_ID, { store, asks, todos });
	} finally {
		store?.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** One line of a project watch: the reply, or an event. */
const ProjectWatchLine = Type.Union([
	Type.Object({ ok: Type.Literal(true), value: ProjectState }),
	Type.Object({ event: ProjectEvent }),
]);

/**
 * A `watch-project` request of the host `host` on a socket of its own: its socket, the state of the reply, and the
 * events that came so far.
 */
export async function watchProject(
	host: string,
): Promise<{ socket: Socket; state: ProjectState; events: ProjectEvent[] }> {
	const socket = createConnection(statePaths(host).socket);
	await once(socket, "connect");
	const replies: ProjectState[] = [];
	const events: ProjectEvent[] = [];

	onLines(socket, (line) => {
		const parsed: unknown = JSON.parse(line);

		if (!Value.Check(ProjectWatchLine, parsed)) throw new Error(`not a line of a project watch: ${line.slice(0, 200)}`);

		if ("ok" in parsed) replies.push(parsed.value);
		else events.push(parsed.event);
	});

	socket.write(`${JSON.stringify({ type: "watch-project" })}\n`);
	await until(() => replies.length > 0);
	const [state] = replies;

	if (state === undefined) throw new Error("no reply");

	return { socket, state, events };
}

/** Polls `check` for up to 10 s. */
export async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));

	if (!check()) throw new Error("timed out");
}

export function called(prompt: string): number {
	return calls.filter((call) => call.prompt === prompt).length;
}

/** The keys of Pi's global settings that the tests set. */
export type TestSettings = {
	readonly agentDepthLimit?: number;
};

/** Writes Pi's global settings of the tests: no retry, and `settings`. */
export async function setSettings(settings: TestSettings = {}): Promise<void> {
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, ...settings }));
}

/**
 * A watch of `target` in the running host, on a connection of its own: the reply, the lines that came so far, and the
 * end of the lines.
 */
export async function openWatch(target: Target): Promise<{
	client: Client;
	view: ConversationView;
	child: ChildInfo;
	lines: WatchLine[];
	ended: Promise<void>;
}> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");
	const watched = await client.watch(target);
	const lines: WatchLine[] = [];

	const ended = (async () => {
		for await (const line of watched.lines) lines.push(line);
	})();

	return { client, view: watched.view, child: watched.child, lines, ended };
}

/** Sends `message` to the host agent and gives the verb. */
export async function inputAgent(client: Client, message: string): Promise<string> {
	const reply = await client.request({
		type: "input",
		requestId: `input-${message}`,
		handle: AGENT_HANDLE,
		message,
		followUp: false,
	});

	return reply.verb;
}

/** Waits for an idle event after a busy one. */
export async function untilIdleAfterBusy(events: readonly WatchLine[]): Promise<void> {
	const busy = () => events.findIndex((line) => line.child.state === "busy");
	await until(() => busy() !== -1 && events.slice(busy() + 1).some((line) => line.child.state === "idle"));
}

/** Sends `message` to the host agent, and waits until its turn ends. */
export async function agentTurn(message: string): Promise<void> {
	const { client, lines } = await openWatch({ kind: "agent" });

	try {
		await inputAgent(client, message);
		await untilIdleAfterBusy(lines);
	} finally {
		client.close();
	}
}

/**
 * The options of a spawn through the socket: whether its answers are pushed, its request ID
 * (`<caller>:<prompt>` by default), its host, what the child serves, and its labels.
 */
type SpawnOptions = {
	readonly notify: boolean;
	readonly requestId?: string;
	readonly host?: string;
	readonly serves?: SpawnServes;
	readonly labels?: readonly string[];
};

/** Spawns a child of `caller` with the first message `prompt` through the socket, as the tool does. */
export async function spawnAs(caller: string, prompt: string, options: SpawnOptions): Promise<ChildInfo> {
	let spawn: Extract<Request, { type: "spawn" }> = {
		type: "spawn",
		requestId: options.requestId ?? `${caller}:${prompt}`,
		caller,
		notify: options.notify,
		provider: "faux",
		model: "faux-1",
		callerThinking: "medium",
		cwd: root,
		prompt,
	};

	if (options.serves !== undefined) spawn = { ...spawn, serves: options.serves };

	if (options.labels !== undefined) spawn = { ...spawn, labels: [...options.labels] };

	const spawned = await request(spawn, {
		start: false,
		host: options.host,
	});

	if (spawned === undefined) throw new Error("no host");

	return spawned;
}

/** The answer that a `wait` for `handle` gives, in the host `host`. */
export async function answerOf(handle: string, host?: string): Promise<string> {
	const reply = await request({ type: "wait", handle, timeout: 10 }, { start: false, host });

	if (reply === undefined) throw new Error("no host");

	return reply.answer;
}

/**
 * The handle and the conversation ID of a new child of `caller`, which prints its `PI_SESSION_ID`, and serves `serves`.
 * The request ID comes from `requestId`, by default the caller.
 */
export async function spawnWithId(
	caller: string,
	options: { readonly serves?: SpawnServes; readonly requestId?: string } = {},
): Promise<{ handle: string; id: string }> {
	const child = await spawnAs(caller, "Task:\nEnvironment", { notify: false, ...options });
	const id = /^Tool said: (\d+) /.exec(await answerOf(child.handle))?.[1];

	if (id === undefined) throw new Error("no conversation ID");

	return { handle: child.handle, id };
}

/**
 * Sends `line` to the host `host`, the main host by default, through the socket: a request of the host to the host,
 * else a request of an entry. The reply of an entry is not checked.
 */
export async function sendLine(
	line: Request | ProjectRequest | EntryRequestLine,
	options: { readonly host?: string | undefined; readonly signal?: AbortSignal } = {},
): Promise<Replies[Request["type"]] | JsonValue> {
	const connect = { start: false, ...options };

	const reply = Value.Check(RequestLine, line)
		? await request(line, connect)
		: await requestEntry(Value.Parse(EntryLine, copyJson(line)), connect);

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Sends `line`, a request of the host, to the host `host`, the main host by default, through the socket. */
export async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	host?: string,
): Promise<Replies[T]>;
/** Sends `line`, a request of the projects entry, to the host `host`, the main host by default, through the socket. */
export async function send<T extends ProjectRequest["type"]>(
	line: Extract<ProjectRequest, { type: T }>,
	host?: string,
): Promise<ProjectReplies[T]>;
export async function send(
	line: Request | ProjectRequest,
	host?: string,
): Promise<Replies[Request["type"]] | ProjectReplies[ProjectRequest["type"]]> {
	// SAFETY: the host and the projects entry reply to a request of a type with the value of `Replies` of that type.
	return (await sendLine(line, { host })) as Replies[Request["type"]] | ProjectReplies[ProjectRequest["type"]];
}

/** Writes a round of `asks` for the parley `parley` as the caller `caller`, and gives the reply. */
export async function round(
	caller: string,
	parley: Extract<Request, { type: "ask"; action: "round" }>["parley"],
	asks: Extract<Request, { type: "ask"; action: "round" }>["asks"],
): Promise<AskWrite> {
	const line = parley === undefined ? { asks } : { parley, asks };

	return Value.Parse(AskWrite, await send({ type: "ask", action: "round", caller, ...line }));
}

/** Writes `answers` of the user as the caller `user`, and gives the reply. */
export async function answer(
	answers: Extract<Request, { type: "ask"; action: "answer" }>["answers"],
): Promise<AskWrite> {
	return Value.Parse(AskWrite, await send({ type: "ask", action: "answer", caller: "user", answers, user: true }));
}

/** The options of an ask with two options: `a`, with its gains and its costs, and `b`. */
export const OPTIONS = [
	{ key: "a", label: "In the store", gains: ["One writer"], costs: ["A protocol bump"] },
	{ key: "b", label: "In files" },
];

/** A parley `slug` with one call, its design sense and a read-back: the IDs of its call and of its read-back. */
export async function framed(slug: string): Promise<{ call: number; readBack: number }> {
	const written = await round(
		"pi-1",
		{ slug, title: "Where asks live", goal: "Pick the place.", design_sense: "One writer." },
		[{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
	);

	const [call, readBack] = (written.parleys[0]?.asks ?? []).map((ask) => ask.id);

	if (call === undefined || readBack === undefined) throw new Error("no asks");

	return { call, readBack };
}

/**
 * Waits until the parley `slug` of the host `host`, the main host by default, is a contract, and gives it with its
 * asks: the event of the answered read-back makes the contract after the answer.
 */
export async function untilContract(slug: string, host?: string): Promise<ParleyAsks> {
	return vi.waitFor(
		async () => {
			const read = Value.Parse(ParleyAsks, await send({ type: "parley", action: "read", slug }, host));

			if (read.parley.status !== "contract") throw new Error(`Parley ${slug} is ${read.parley.status}`);

			return read;
		},
		{ timeout: 10_000 },
	);
}

/** The ID of the first open item that the parley `slug` shapes, as `item list` gives it. */
export async function contractItem(slug: string): Promise<number> {
	const { items } = Value.Parse(ItemList, await send({ type: "item", action: "list" }));
	const end = `parley:${slug}`;
	const item = items.find((found) => found.edges.some((edge) => edge.from === end && edge.kind === "shapes"));

	if (item === undefined) throw new Error(`no item shaped by ${slug}`);

	return item.id;
}

/** Removes the edge of the parley `slug` to its open item, so the contract shapes no item. */
export async function unlinkContract(slug: string): Promise<void> {
	const to = `item:${await contractItem(slug)}`;
	await send({ type: "item", action: "unlink", caller: "cli", from: `parley:${slug}`, kind: "shapes", to });
}

/** The state of the child `handle` of the main host, or nothing when no host runs. */
export async function stateOf(handle: string): Promise<string | undefined> {
	return (await request({ type: "status", handle }, { start: false }))?.state;
}

/** Waits until the child `handle` of the main host has the state `state`. */
export async function untilState(handle: string, state: string): Promise<void> {
	await vi.waitFor(async () => expect(await stateOf(handle)).toBe(state), { timeout: 10_000 });
}

/** What the pi-durable test hosts report, such as a structured output that does not match the tool's schema. */
export const reports: unknown[] = [];

/** A pi-durable host over `store` with `extensions`, which adds its reports to `reports`. */
export async function openDurableHost(store: string, extensions: readonly Extension[]): Promise<Harness> {
	const registry = createRegistry();

	for (const extension of extensions) registry.install(extension);

	return Harness.open(
		await openNodeSqliteStorage(store),
		{ models, registry, onReport: (report) => reports.push(report) },
		BACKGROUND_CONTEXT,
	);
}

/**
 * The content of the first assistant message of the answer of `settled`, a submission of `harness`. It throws when the
 * submission is not done or has no answer.
 */
export async function answerContent(
	harness: Harness,
	settled: SettledSubmissionRecord,
): Promise<AssistantMessage["content"]> {
	if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
	const answer = settled.answer;
	const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), BACKGROUND_CONTEXT);
	const message = entry?.model?.[0];

	return message?.role === "assistant" ? message.content : [];
}

/** Makes a temporary root with the agent dir, home and state, points `process.env` at it and sets up the faux provider. */
export async function setUp(): Promise<void> {
	// macOS limits a Unix socket path to 104 bytes, so the state stays short, under /tmp.
	root = await mkdtemp("/tmp/harness-");
	requests.clear();
	contexts.clear();
	await mkdir(join(root, "agent"));
	await mkdir(join(root, "home"));
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	replaceEnvironment({
		...environment,
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "config"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		HOME: join(root, "home"),
		PI_PROVIDER: "faux",
		PI_MODEL: "faux-1",
	});

	for (const name of [
		"PI_SESSION_ID",
		"PI_REASONING_LEVEL",
		"PI_SESSION_FILE",
		"HC_TERMINAL_ID",
		"HARNESS_HOST",
		"MEMORY_DIR",
		"VAULT",
		// Node warns on stderr when both are set, and the tests compare stderr.
		"FORCE_COLOR",
		"NO_COLOR",
	]) {
		delete process.env[name];
	}

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", reasoning: true }],
	});

	faux.setResponses(Array.from({ length: 500 }, () => respond));
	models.setProvider(faux.provider);
	// The host loads the projects entry of this checkout.
	setEntry("projects", PROJECTS_MODULE);
}

/** The module of the projects entry, which `setUp` sets in `entries.json`. */
const PROJECTS_MODULE = fileURLToPath(new URL("../src/projects/index.ts", import.meta.url));

/**
 * The module of the projects fixture entry, which loads the projects entry and keeps the handles of the host. A test
 * that needs a handle sets it in place of `PROJECTS_MODULE`.
 */
export const PROJECTS_FIXTURE = fileURLToPath(new URL("fixtures/projects.ts", import.meta.url));

/**
 * Makes `values` the environment of this process. It changes `process.env` in place, so `os.homedir()` also reads the
 * new `HOME`.
 */
function replaceEnvironment(values: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(process.env)) if (!Object.hasOwn(values, name)) delete process.env[name];

	for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
}

/** Restores `process.env` and removes the temporary root. */
export async function tearDown(): Promise<void> {
	replaceEnvironment(environment);
	await rm(root, { recursive: true, force: true });
}
