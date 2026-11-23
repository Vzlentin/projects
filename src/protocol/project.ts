/**
 * The store of the project: persons, threads, messages, rules, held actions and parleys, their inputs, their lists and
 * the texts of their lines.
 */
import {
	type Ask,
	askLine,
	Caller,
	isFinished,
	isReadBack,
	LocalId,
	Parley,
	type ParleyAsks,
	StoreId,
	Text,
	Time,
} from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";

/**
 * The name of the durable extension with the tools of the store of the project: `thread`, `rule`, `parley` and `item`. A
 * client of `children.open` leaves these tools out when its `setup` adds this name to the `remove` of the extensions
 * of the child's `AgentDoc`.
 */
export const PROJECT_EXTENSION = "harness-project";

/**
 * The name of the durable extension with the `memory` tool and the memory section of the system prompt. Only the host
 * agent gets it: the entry lists it in `uninherited`, so `children.open` removes it from each child.
 */
export const MEMORY_EXTENSION = "harness-memory";

/** The key of the system prompt section with the memory of the host agent. */
export const MEMORY_SECTION = "memory";

/** Who said or wrote something: the ID of a person, or `user`. */
export const Author = Type.Union([LocalId, Type.Literal("user")]);

export type Author = Static<typeof Author>;

/** A person that the user talks with. */
export const Person = Type.Object({ id: LocalId, name: Text });

export type Person = Static<typeof Person>;

/**
 * A thread of messages with one or more persons. Its ID is the ID of its conversation, and `last` is the latest `at` of
 * its messages, absent while it has none.
 */
export const Thread = Type.Object({
	id: StoreId,
	topic: Text,
	persons: Type.Array(LocalId, { minItems: 1 }),
	last: Type.Optional(Time),
});

export type Thread = Static<typeof Thread>;

/** The directions of a message: `in` from a person, `out` to the persons. */
export const MESSAGE_DIRECTIONS = ["in", "out"] as const;

export const MessageDirection = Type.Enum(MESSAGE_DIRECTIONS);

export type MessageDirection = Static<typeof MessageDirection>;

/**
 * The states of a message: `received` for a message in, and for a message out `draft`, `sent`, `answered` or
 * `dropped`.
 */
export const MESSAGE_STATES = ["received", "draft", "sent", "answered", "dropped"] as const;

export const MessageState = Type.Enum(MESSAGE_STATES);

export type MessageState = Static<typeof MessageState>;

/** The states that a request can mark a message out with. */
export const MESSAGE_MARKS = ["sent", "draft", "dropped"] as const;

export const MessageMark = Type.Enum(MESSAGE_MARKS);

export type MessageMark = Static<typeof MessageMark>;

/** An event of a message out: a mark, or `reply`, a later message in of a person of its thread. */
export type MessageEvent = MessageMark | "reply";

/**
 * The state of a message out in the state `state` after `event`, or `undefined` when the event cannot change it. A draft
 * becomes `sent` with a mark `sent` or a reply, and `dropped` with a mark `dropped`. A sent message becomes `draft` with
 * a mark `draft`, and `answered` with a reply.
 */
export function messageTransition(state: MessageState, event: MessageEvent): MessageState | undefined {
	switch (state) {
		case "draft":
			if (event === "sent" || event === "reply") return "sent";

			return event === "dropped" ? "dropped" : undefined;
		case "sent":
			if (event === "reply") return "answered";

			return event === "draft" ? "draft" : undefined;
		default:
			return undefined;
	}
}

/** Whether a message in the state `state` waits on the user or on a person: a draft, or a sent message. */
export function isWaiting(state: MessageState): boolean {
	return state === "draft" || state === "sent";
}

/**
 * A message of a thread. Its ID is the ID of its entry, `at` is in epoch milliseconds, and `by` is the caller that logged
 * it.
 */
export const Message = Type.Object({
	id: StoreId,
	thread: StoreId,
	from: Author,
	direction: MessageDirection,
	state: MessageState,
	at: Time,
	text: Text,
	by: Caller,
});

export type Message = Static<typeof Message>;

/** The kinds of a rule: `conduct` for how an agent acts, `domain` for a fact of the project. */
export const RULE_KINDS = ["conduct", "domain"] as const;

export const RuleKind = Type.Enum(RULE_KINDS);

export type RuleKind = Static<typeof RuleKind>;

/** The states of a rule. */
export const RULE_STATES = ["open", "decided", "retired"] as const;

export const RuleStatus = Type.Enum(RULE_STATES);

export type RuleStatus = Static<typeof RuleStatus>;

/**
 * A rule of the project, with who said it, the message that is its source, and the thread of that message. A rule that
 * the user creates or edits has no source and no thread. `at` is the time of its last change, in epoch milliseconds,
 * and `by` is the caller of that change.
 */
export const Rule = Type.Object({
	id: LocalId,
	name: Text,
	kind: RuleKind,
	value: Text,
	status: RuleStatus,
	saidBy: Author,
	source: Type.Optional(StoreId),
	/** The thread of the message `source`; a rule with no source has none. */
	thread: Type.Optional(StoreId),
	replaces: Type.Optional(LocalId),
	at: Time,
	by: Caller,
});

export type Rule = Static<typeof Rule>;

/**
 * The fields of each held action: the request ID of the call that the gate held, the caller that made it, its tool, its
 * command as it runs, the decided conduct rule that it breaks, absent when the gate failed or the call changes a rule,
 * and the reason. `at` is the time of its last change, and `by` is the caller of that change.
 */
export const HeldFields = {
	id: LocalId,
	requestId: Type.String(),
	agent: Caller,
	tool: Type.String(),
	command: Type.String(),
	rule: Type.Optional(LocalId),
	reason: Type.String(),
	at: Time,
	by: Caller,
};

/**
 * A tool call that the gate held, in one of its three states: `held` until the user approves or drops it, then `approved`
 * or `dropped`. Only an approved action has `ran`: the request ID of the one call that it let run,
 * and its time.
 */
export const HeldAction = Type.Union([
	Type.Object({ ...HeldFields, state: Type.Literal("held") }),
	Type.Object({
		...HeldFields,
		state: Type.Literal("approved"),
		ran: Type.Optional(Type.Object({ requestId: Type.String(), at: Time })),
	}),
	Type.Object({ ...HeldFields, state: Type.Literal("dropped") }),
]);

export type HeldAction = Static<typeof HeldAction>;

/** The input of a new held action. */
export type HeldInput = Pick<HeldAction, "requestId" | "agent" | "tool" | "command" | "rule" | "reason">;

/** The rule of a plain text, as a request error and the parley tool give it. */

/** The input of a new person. */
export const PersonAdd = Type.Object({ name: Text });

export type PersonAdd = Static<typeof PersonAdd>;

/** The input of a new thread, with one or more persons. */
export const ThreadAdd = Type.Object({ topic: Thread.properties.topic, persons: Thread.properties.persons });

export type ThreadAdd = Static<typeof ThreadAdd>;

/**
 * The input of a new message. The host sets its state from its direction, and `at` defaults to now. `state: "sent"`
 * logs a message out as sent, with no draft.
 */
export const MessageLog = Type.Object({
	thread: StoreId,
	from: Author,
	direction: MessageDirection,
	at: Type.Optional(Time),
	text: Text,
	state: Type.Optional(Type.Literal("sent")),
});

export type MessageLog = Static<typeof MessageLog>;

/**
 * The input of an edit of the message `message`: its new text, and its new time and author when they are given. The
 * author sets the direction: `out` for `user`, `in` for a person of the thread.
 */
export const MessageEdit = Type.Object({
	message: StoreId,
	text: Text,
	at: Type.Optional(Time),
	from: Type.Optional(Author),
});

export type MessageEdit = Static<typeof MessageEdit>;

/** The input of a delete of the message `message`. */
export const MessageDelete = Type.Object({ message: StoreId });

export type MessageDelete = Static<typeof MessageDelete>;

/** The input of a join of the person `person` to the thread `id`. */
export const ThreadJoin = Type.Object({ id: StoreId, person: LocalId });

export type ThreadJoin = Static<typeof ThreadJoin>;

/** The input of a mark of the message out `message` with `state`. */
export const MessageMarkInput = Type.Object({ message: StoreId, state: MessageMark });

export type MessageMarkInput = Static<typeof MessageMarkInput>;

/**
 * The input of a new rule of an agent, which can name the older rule that it replaces. Its status is `open`: only the
 * user changes the status of a rule.
 */
export const RuleNew = Type.Object({
	id: Type.Optional(Type.Never()),
	name: Text,
	kind: RuleKind,
	value: Text,
	status: Type.Optional(Type.Never()),
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
});

export type RuleNew = Static<typeof RuleNew>;

/** The input of a change of the open rule `id` by an agent. The host refuses `replaces` on a change. */
export const RuleEdit = Type.Object({
	id: LocalId,
	name: Type.Optional(Text),
	kind: Type.Optional(RuleKind),
	value: Type.Optional(Text),
	status: Type.Optional(Type.Never()),
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
});

export type RuleEdit = Static<typeof RuleEdit>;

/** The input of a rule set: a new rule without `id`, a change of a rule with `id`. */
export const RuleSet = Type.Union([RuleNew, RuleEdit]);

export type RuleSet = Static<typeof RuleSet>;

/**
 * A change of the status of the rule `id` by the user: `decide` puts an open rule in effect, `retire` ends an open or a
 * decided rule, and `delete` removes the rule.
 */
export const RuleStateChange = Type.Object({
	action: Type.Union([Type.Literal("decide"), Type.Literal("retire"), Type.Literal("delete")]),
	id: LocalId,
});

export type RuleStateChange = Static<typeof RuleStateChange>;

/** A change of the text of the rule `id`, in any status, by the user. */
export const RuleUserEdit = Type.Object({
	action: Type.Literal("edit"),
	id: LocalId,
	name: Type.Optional(Text),
	kind: Type.Optional(RuleKind),
	value: Type.Optional(Text),
});

export type RuleUserEdit = Static<typeof RuleUserEdit>;

/** A new rule of the user, which is decided. */
export const RuleCreate = Type.Object({ action: Type.Literal("create"), name: Text, kind: RuleKind, value: Text });

export type RuleCreate = Static<typeof RuleCreate>;

/** A change of a rule that only the user makes. */
export type RuleUserChange = RuleStateChange | RuleUserEdit | RuleCreate;

/** The filter of a read of the rules: only the rules of `kind` and of `status` when they are given. */
export const RuleFilter = Type.Object({ kind: Type.Optional(RuleKind), status: Type.Optional(RuleStatus) });

export type RuleFilter = Static<typeof RuleFilter>;

/** The kind of the entry of a digest in the conversation of a hosted agent. */
export const DIGEST_KIND = "harness.digest";

/** The reply of `digest`: the text of the digest that the caller gets, absent when it gets none. */
export const DigestReply = Type.Object({ text: Type.Optional(Type.String()) });

export type DigestReply = Static<typeof DigestReply>;

/** The reply to a `memory` request. */
export const MemoryReply = Type.Object({ text: Type.String() });

export type MemoryReply = Static<typeof MemoryReply>;

export const PersonList = Type.Object({ persons: Type.Array(Person) });

export type PersonList = Static<typeof PersonList>;

export const ThreadList = Type.Object({ threads: Type.Array(Thread) });

export type ThreadList = Static<typeof ThreadList>;

export const RuleList = Type.Object({ rules: Type.Array(Rule) });

export type RuleList = Static<typeof RuleList>;

export const HeldList = Type.Object({ held: Type.Array(HeldAction) });

export type HeldList = Static<typeof HeldList>;

export const ParleyList = Type.Object({ parleys: Type.Array(Parley) });

export type ParleyList = Static<typeof ParleyList>;

/** A thread and its messages, oldest first. */
export const ThreadMessages = Type.Object({ thread: Thread, messages: Type.Array(Message) });

export type ThreadMessages = Static<typeof ThreadMessages>;

/** A thread of `watch-project`, with its messages in the state `draft` or `sent`, oldest first. */
export const ProjectThread = Type.Object({ ...Thread.properties, waits: Type.Array(Message) });

export type ProjectThread = Static<typeof ProjectThread>;

/** The names of the persons, by ID. */
export type PersonNames = ReadonlyMap<number, string>;

/** The names of the persons of `list`, by ID. */
export function personNames(list: PersonList): PersonNames {
	return new Map(list.persons.map((person) => [person.id, person.name]));
}

/**
 * `author` in a line: `user`, the name of the person and its ID, as `Sam (1)`, or `person <id>` for a person that
 * `names` does not have.
 */
export function authorText(author: Author, names: PersonNames): string {
	if (author === "user") return author;
	const name = names.get(author);

	return name === undefined ? `person ${author}` : `${name} (${author})`;
}

function time(at: number): string {
	return new Date(at).toISOString();
}

export function threadLine(thread: Thread, names: PersonNames): string {
	const persons = thread.persons.map((person) => authorText(person, names)).join(", ");
	const last = thread.last === undefined ? "no messages" : `last message ${time(thread.last)}`;

	return `${thread.id} ${thread.topic} with ${persons}: ${last}`;
}

export function messageLine(message: Message, names: PersonNames): string {
	return `${message.id} ${time(message.at)} ${authorText(message.from, names)} (${message.state}): ${message.text}`;
}

function saidLine(fact: Pick<Rule, "saidBy" | "source">, names: PersonNames): string {
	const source = fact.source === undefined ? "" : ` in message ${fact.source}`;

	return `said by ${authorText(fact.saidBy, names)}${source}`;
}

export function ruleLine(rule: Rule, names: PersonNames): string {
	const replaces = rule.replaces === undefined ? "" : `; replaces ${rule.replaces}`;

	return `${rule.id} ${rule.name} (${rule.kind}, ${rule.status}): ${rule.value} [${saidLine(rule, names)}${replaces}]`;
}

/** The key of the system prompt section with the decided rules of the project. */
export const RULES_SECTION = "project_rules";

/**
 * The text of the system prompt section of the decided rules in `rules`: the conduct rules, then the domain rules, each
 * group in ID order. It is undefined when no rule is decided.
 */
export function rulesSection(rules: readonly Rule[]): string | undefined {
	const decided = rules.filter((rule) => rule.status === "decided");

	if (decided.length === 0) return undefined;

	const lines = RULE_KINDS.flatMap((kind) =>
		decided
			.filter((rule) => rule.kind === kind)
			.sort((a, b) => a.id - b.id)
			.map((rule) => `${rule.id} ${rule.name} (${rule.kind}): ${rule.value}`),
	);

	return [
		"A rule is what a person of the project said that each agent follows (conduct) or knows as true (domain); only the user puts a rule in effect. Propose a rule with the `rule` tool, and never write a rule into `AGENTS.md`.",
		...lines,
	].join("\n");
}

/** The fields of a line of a parley or an ask, joined with ` · `. */
function fieldsText(fields: readonly (string | number | undefined)[]): string {
	return fields.filter((field) => field !== undefined).join(" · ");
}

export function parleyLine(parley: Parley): string {
	return fieldsText([parley.slug, parley.status, parley.title]);
}

/** The label of the option `key` of `ask`, when it has one. */
function optionLabel(ask: Ask, key: string | undefined): string | undefined {
	return ask.options?.find((option) => option.key === key)?.label;
}

/** The label of the answer of `ask`: its own label, else the label of the chosen option, else the label of the answer. */
function answerLabel(ask: Extract<Ask, { readonly state: "answered" }>): string | undefined {
	return ask.answer === "own" ? ask.label : (optionLabel(ask, ask.answer) ?? ask.label);
}

/** The number of `ask` in its parley, or its ID when it has no parley. */
function askNumber(ask: Ask): number {
	return ask.parley?.n ?? ask.id;
}

/**
 * The last line of the parley `parley` with its asks `asks`. For an open parley, the answer line: the plan of each open
 * your call with a plan, then `ok` when no ask is open or when another ask is open. For any other status, the command
 * that shows the parley.
 */
function parleyAnswerLine(parley: Parley, asks: readonly Ask[]): string {
	if (parley.status !== "open") return `harness parley show ${parley.slug}`;
	const open = asks.filter((ask) => ask.state === "open");
	const calls = open.filter((ask) => ask.kind === "your call" && ask.plan !== undefined);
	const parts = calls.map((ask) => `${askNumber(ask)}${ask.plan}`);

	if (open.length === 0 || calls.length < open.length) parts.push("ok");

	return `[${parley.slug}] ${parts.join(" ")}`;
}

/** The lines of the options of `ask` while it is open, each `  <key> · <label>` with its gains and its costs. */
function optionLines(ask: Ask): string[] {
	if (ask.state !== "open") return [];

	return (ask.options ?? []).map((option) => {
		const gains = option.gains === undefined ? undefined : `gains: ${option.gains.join("; ")}`;
		const costs = option.costs === undefined ? undefined : `costs: ${option.costs.join("; ")}`;

		return `  ${fieldsText([option.key, option.label, gains, costs])}`;
	});
}

/**
 * The text of a parley: its line, the line of each of its asks with the options of each open ask and the words of the
 * user under each answered ask, and its answer line.
 */
export function parleyText(reply: ParleyAsks): string {
	const asks = reply.asks.flatMap((ask) => [
		askLine(ask),
		...optionLines(ask),
		...(ask.state === "answered" ? (ask.words ?? []) : []),
	]);

	return [parleyLine(reply.parley), ...asks, parleyAnswerLine(reply.parley, reply.asks)]
		.map((line) => `${line}\n`)
		.join("");
}

/** The state line of `ask` in the text of `harness parley show`: its answer, its plan when it is open, or `Dropped`. */
function askStateText(ask: Ask): string {
	switch (ask.state) {
		case "open": {
			const label = optionLabel(ask, ask.plan);

			return ask.plan === undefined ? "Open" : `Open, plan ${ask.plan}${label === undefined ? "" : `: ${label}`}`;
		}

		case "answered":
			return `Answer: ${answerLabel(ask) ?? ask.answer}`;

		default:
			return "Dropped";
	}
}

/**
 * The text of `harness parley show`, in Markdown: the title of the parley, with its status when it is done or dropped,
 * its goal, then each ask with options, with its state and the words of the user, then the design sense and the
 * evidence when they are set. It leaves out the read-back, which is the ask with no options.
 */
export function parleyShowText(reply: ParleyAsks): string {
	const { parley } = reply;
	const status = isFinished(parley.status) ? ` (${parley.status})` : "";
	const blocks = [`# ${parley.title}${status}`, parley.goal];

	for (const ask of reply.asks) {
		if (isReadBack(ask)) continue;
		blocks.push(`## ${askNumber(ask)}. ${ask.title}`, askStateText(ask));

		if (ask.state === "answered") blocks.push(...(ask.words ?? []));
	}

	if (parley.design_sense !== undefined) blocks.push("## Design sense", parley.design_sense);

	if (parley.evidence !== undefined) {
		blocks.push("## Evidence", parley.evidence.map((item) => `- ${item}`).join("\n"));
	}

	return `${blocks.join("\n\n")}\n`;
}
