/** The requests that the projects entry serves on the host socket, and the value of the reply to each of them. */
import type { JsonValue } from "@earendil-works/chord/json";
import { LocalId, type Parley, type ParleyAsks, ParleyEnd, Slug } from "@vzlentin/harness/protocol";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { GateReply, ToolArguments } from "./gate.ts";
import { type Edge, EdgeInput, ItemAdd, type ItemList, ItemSet, ItemState, type StagedItem } from "./item.ts";
import type { ProjectState } from "./project-watch.ts";
import {
	type DigestReply,
	type HeldAction,
	type MemoryReply,
	type Message,
	MessageDelete,
	MessageEdit,
	MessageLog,
	MessageMarkInput,
	type ParleyList,
	type Person,
	PersonAdd,
	type PersonList,
	type Rule,
	RuleCreate,
	RuleEditFromSource,
	RuleEditFromWords,
	RuleFilter,
	type RuleList,
	RuleNewFromSource,
	RuleNewFromWords,
	RuleStateChange,
	RuleUserEdit,
	Thread,
	ThreadAdd,
	ThreadJoin,
	type ThreadList,
	type ThreadMessages,
} from "./project.ts";

/**
 * One request line of a type that the projects entry serves: the persons, threads, messages, digests, memory, rules,
 * parleys, items, gate, held actions and the watch of the project. The entry checks it with the branches of its type.
 */
export const ProjectRequestLine = Type.Union([
	/** Adds a person, and replies with it. */
	Type.Object({ type: Type.Literal("person"), action: Type.Literal("add"), ...PersonAdd.properties }),
	/** Replies with the persons, in ID order. */
	Type.Object({ type: Type.Literal("person"), action: Type.Literal("list") }),
	/** Adds a thread with one or more persons, in a new ownerless conversation, and replies with it. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("add"), ...ThreadAdd.properties }),
	/** Replies with the threads, in ID order. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("list") }),
	/** Replies with the thread `id` and its messages, oldest first. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("read"), id: Thread.properties.id }),
	/** Adds the person `person` to the thread `id`, and replies with the thread. No tool sends it. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("join"), ...ThreadJoin.properties }),
	/**
	 * Adds a message to a thread, and replies with it. The host sets its state from its direction, or `sent` for a
	 * message out with `state: "sent"`. A message in from a person of the thread moves each earlier message out that
	 * waits one step: a draft to `sent`, a sent one to `answered`.
	 */
	Type.Object({
		type: Type.Literal("message"),
		action: Type.Literal("log"),
		caller: Type.String(),
		...MessageLog.properties,
	}),
	/** Marks the message out `message` with `state`, and replies with it. A mark that its state cannot take fails. */
	Type.Object({
		type: Type.Literal("message"),
		action: Type.Literal("mark"),
		caller: Type.String(),
		...MessageMarkInput.properties,
	}),
	/**
	 * Changes the text, the time and the author of the message `message` for the caller, who becomes its `by`, and
	 * replies with it. Its ID stays the same. No tool sends it.
	 */
	Type.Object({
		type: Type.Literal("message"),
		action: Type.Literal("edit"),
		caller: Type.String(),
		...MessageEdit.properties,
	}),
	/** Removes the message `message`, and replies with it as it was. No tool sends it. */
	Type.Object({
		type: Type.Literal("message"),
		action: Type.Literal("delete"),
		caller: Type.String(),
		...MessageDelete.properties,
	}),
	/**
	 * Replies with the digest of `caller`, the messages out that wait and its held actions, when it changed since the
	 * last digest of the caller or when `head`, the ID of the newest compaction of its context, is new, and records it as
	 * given. A Pi session sends it before each turn, with the ID of its newest compaction entry as `head`.
	 */
	Type.Object({ type: Type.Literal("digest"), caller: Type.String(), head: Type.Optional(Type.String()) }),
	/** Saves `text` as a memory of the host agent, and replies with the `Saved as #<N>.` line of OptMem. */
	Type.Object({ type: Type.Literal("memory"), action: Type.Literal("note"), text: Type.String() }),
	/** Replies with the memories of the host agent that match the regex `pattern`. */
	Type.Object({ type: Type.Literal("memory"), action: Type.Literal("recall"), pattern: Type.String() }),
	/** Replies with the two halves of the node `block` of the memory of the host agent. */
	Type.Object({ type: Type.Literal("memory"), action: Type.Literal("zoom"), block: Type.String() }),
	/**
	 * Replies with the memory of the host agent as the text of the memory section, or with an empty text for an empty
	 * memory. A Pi session sends it at its first turn.
	 */
	Type.Object({ type: Type.Literal("memory"), action: Type.Literal("snapshot") }),
	/** Adds an open rule with its source message, which can name the rule `replaces`, and replies with it. */
	Type.Object({
		type: Type.Literal("rule"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...RuleNewFromSource.properties,
	}),
	/**
	 * Changes the open rule `id` with its source message, and replies with it. The rule sets with a source come first, so
	 * a rule set with neither `source` nor `words` fails on `source`. The host refuses a change with `replaces`, and a
	 * change of a rule that is not open.
	 */
	Type.Object({
		type: Type.Literal("rule"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...RuleEditFromSource.properties,
	}),
	/**
	 * Adds a rule with the exact words of the user, which is decided at once and retires the rule `replaces`, and replies
	 * with it.
	 */
	Type.Object({
		type: Type.Literal("rule"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...RuleNewFromWords.properties,
	}),
	/**
	 * Changes the open rule `id` with the exact words of the user, which decide it at once and retire the rule that it
	 * replaces, and replies with it.
	 */
	Type.Object({
		type: Type.Literal("rule"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...RuleEditFromWords.properties,
	}),
	/** Replies with the rules, in ID order: with `kind` or `status`, only those that have it. */
	Type.Object({ type: Type.Literal("rule"), action: Type.Literal("list"), ...RuleFilter.properties }),
	/**
	 * Decides, retires or deletes the rule `id` for the user, and replies with it. A decide retires the rule that the
	 * decided rule replaces. No tool sends it.
	 */
	Type.Object({ type: Type.Literal("rule"), caller: Type.String(), ...RuleStateChange.properties }),
	/** Changes the text of the rule `id` for the user, who becomes its author, and replies with it. No tool sends it. */
	Type.Object({ type: Type.Literal("rule"), caller: Type.String(), ...RuleUserEdit.properties }),
	/** Adds a decided rule of the user, and replies with it. No tool sends it. */
	Type.Object({ type: Type.Literal("rule"), caller: Type.String(), ...RuleCreate.properties }),
	/**
	 * Makes the caller the asker of the open asks of the parley `slug`, open or a contract, and replies with the parley
	 * and its asks.
	 */
	Type.Object({ type: Type.Literal("parley"), action: Type.Literal("take"), caller: Type.String(), slug: Slug }),
	/**
	 * Ends the contract `slug` as `done` or `dropped`, and replies with the parley. A contract that shapes an open item
	 * does not end: the close of its last open item ends it. The end stops the workers of `parley:<slug>`.
	 */
	Type.Object({
		type: Type.Literal("parley"),
		action: Type.Literal("end"),
		caller: Type.String(),
		slug: Slug,
		status: ParleyEnd,
	}),
	/** Replies with the parley `slug` and its asks, in the order of their numbers. */
	Type.Object({ type: Type.Literal("parley"), action: Type.Literal("read"), slug: Slug }),
	/** Replies with the parleys, in ID order. */
	Type.Object({ type: Type.Literal("parley"), action: Type.Literal("list") }),
	/** Adds an open item with the next ID of the counter and no edge, and replies with it. */
	Type.Object({
		type: Type.Literal("item"),
		action: Type.Literal("add"),
		caller: Type.String(),
		...ItemAdd.properties,
	}),
	/**
	 * Changes the fields that it gives of the item `id`, and replies with it. A change to `done` fails while a run or a
	 * task that serves the item is live. A change to `done` or `dropped` ends each contract that shapes the item and no
	 * open item, and stops the workers of the item and of each contract that it ends.
	 */
	Type.Object({
		type: Type.Literal("item"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...ItemSet.properties,
	}),
	/** Replies with the items in the state `state`, default `open`, in ID order. */
	Type.Object({ type: Type.Literal("item"), action: Type.Literal("list"), state: Type.Optional(ItemState) }),
	/** Replies with the item `id` and its edges. */
	Type.Object({ type: Type.Literal("item"), action: Type.Literal("read"), id: LocalId }),
	/**
	 * Checks the edge and writes it into the document of its item, and replies with it. An edge with the same `from`,
	 * `kind` and `to` as an edge of the item is not written again: the reply is the stored edge.
	 */
	Type.Object({
		type: Type.Literal("item"),
		action: Type.Literal("link"),
		caller: Type.String(),
		...EdgeInput.properties,
	}),
	/** Removes an edge that was written by mistake, and replies with its item. */
	Type.Object({
		type: Type.Literal("item"),
		action: Type.Literal("unlink"),
		caller: Type.String(),
		...EdgeInput.properties,
	}),
	/**
	 * Checks the call of the tool `tool` with `arguments` by the agent `caller` against the decided conduct rules of the
	 * project, with `messages`, the last messages of the user in the conversation of the caller, oldest first. It replies
	 * that the call runs, or holds it. A held or dropped call with the same caller and `requestId` is given again.
	 */
	Type.Object({
		type: Type.Literal("gate"),
		requestId: Type.String(),
		caller: Type.String(),
		tool: Type.String(),
		arguments: ToolArguments,
		messages: Type.Immutable(Type.Array(Type.String())),
	}),
	/** Approves or drops the held action `id`, and replies with it. An approve tells its agent. */
	Type.Object({
		type: Type.Literal("held"),
		action: Type.Union([Type.Literal("approve"), Type.Literal("drop")]),
		caller: Type.String(),
		id: LocalId,
	}),
	/**
	 * Replies with the persons, rules, threads with their waits, held actions, parleys and asks of the project, then
	 * sends one `{ event: ProjectEvent }` line after the commits that change them. It needs a connection.
	 */
	Type.Object({ type: Type.Literal("watch-project") }),
]);

export type ProjectRequest = Static<typeof ProjectRequestLine>;

/** The value of the reply to each request type of the projects entry. */
export type Replies = {
	readonly "watch-project": ProjectState;
	/** The person of `add`, or the persons of `list`. */
	readonly person: Person | PersonList;
	/** The thread of `add` and `join`, the threads of `list`, or the thread and its messages of `read`. */
	readonly thread: Thread | ThreadList | ThreadMessages;
	readonly message: Message;
	readonly digest: DigestReply;
	/** The output of OptMem, or the memory section of `snapshot`, with an empty text for an empty memory. */
	readonly memory: MemoryReply;
	/** The rule of `set`, `decide`, `retire`, `delete`, `edit` and `create`, or the rules of `list`. */
	readonly rule: Rule | RuleList;
	readonly gate: GateReply;
	readonly held: HeldAction;
	/** The parley and its asks of `take` and `read`, the parley of `end`, or the parleys of `list`. */
	readonly parley: ParleyAsks | Parley | ParleyList;
	/** The item of `add`, `set`, `read` and `unlink`, the items of `list`, each with its stage, or the edge of `link`. */
	readonly item: StagedItem | ItemList | Edge;
};

/** `reply` as `schema`, the reply that a request expects. It throws when the host replied with another value. */
export function replyOf<T extends TSchema, R extends JsonValue | object>(
	schema: T,
	reply: R,
	expected: string,
): R & Static<T> {
	if (!Value.Check(schema, reply)) throw new Error(`The host replied with no ${expected}`);

	return reply;
}
