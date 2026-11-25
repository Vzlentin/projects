/**
 * The objects of the project that its requests change: the persons, the threads and the messages.
 * They are in the project store (`project-store.ts`), and each function writes them in the transaction of a write. The
 * rules are in `project-rules.ts`, the parleys in `parleys.ts` and the items in `items.ts`.
 */
import {
	type Message,
	type MessageDelete,
	type MessageEdit,
	type MessageLog,
	type MessageMarkInput,
	messageTransition,
	type Person,
	type PersonAdd,
	type Thread,
	type ThreadAdd,
	type ThreadJoin,
	type ThreadMessages,
} from "../protocol/project.ts";
import type { FileMessage } from "../protocol/store-file.ts";
import { releaseSource } from "./project-rules.ts";
import { knownAuthor, replyMessage, type StoreReader, type StoreTx } from "./project-store.ts";

/** Adds a person with the next ID, and gives it. */
export function addPerson(tx: StoreTx, input: PersonAdd): Person {
	return tx.addPerson({ name: input.name });
}

/** Adds a thread with `persons` and the next ID, and gives it. */
export function addThread(tx: StoreTx, input: ThreadAdd): Thread {
	for (const id of input.persons) tx.person(id);

	return tx.addThread({ topic: input.topic, persons: input.persons });
}

/** Adds the person `input.person` to the thread `input.id`, and gives the thread. A person of the thread fails. */
export function joinThread(tx: StoreTx, input: ThreadJoin): Thread {
	tx.person(input.person);
	const thread = tx.thread(input.id);

	if (thread.persons.includes(input.person)) throw new Error(`Person ${input.person} is already in thread ${input.id}`);
	tx.joinThread(thread.id, input.person);

	return { ...thread, persons: [...thread.persons, input.person] };
}

/**
 * Adds a message to the thread `input.thread`, with the state `received` for a message in and `draft` for a message out,
 * or `sent` for a message out with `input.state` `sent`, logged by the caller `by`, and gives it. `at` defaults to now.
 * The `last` of the thread becomes `at` when `at` is later. A message in from a person of the thread is a reply to each
 * message out of the thread that waits and is not later: a draft becomes `sent`, and a sent message `answered`.
 */
export function logMessage(tx: StoreTx, input: MessageLog, by: string): Message {
	if (input.state === "sent" && input.direction === "in") throw new Error("Only a message out can be logged as sent");
	const thread = tx.thread(input.thread);
	knownAuthor(tx, input.from);
	const at = input.at ?? Date.now();
	const fields = { thread: thread.id, from: input.from, at, text: input.text, by };

	const message =
		input.direction === "out"
			? tx.addMessage({ ...fields, direction: "out", state: input.state ?? "draft", changed: { at, by } })
			: tx.addMessage({ ...fields, direction: "in", state: "received" });

	if (input.direction === "in" && input.from !== "user" && thread.persons.includes(input.from)) {
		reply(tx, thread.id, at, by);
	}

	tx.setLast(thread.id, Math.max(thread.last ?? at, at));

	return replyMessage(message);
}

/**
 * Changes the text of the message `input.message`, and its time and author when they are given, for the caller `by`,
 * who becomes its `by`, and gives it. The message keeps its ID. Its direction is `out` for `user` and `in` for a
 * person, who must be a person of the thread. A message that keeps its direction keeps its state and its last change
 * of state. A message out that becomes a message in gets the state `received`, and a message in that becomes a message
 * out gets the state `draft`, changed at its time, as `logMessage` gives it. The edit moves no other message. The `last`
 * of the thread becomes the latest time of its messages.
 */
export function editMessage(tx: StoreTx, input: MessageEdit, by: string): Message {
	const found = tx.message(input.message);
	const thread = tx.thread(found.thread);
	const from = input.from ?? found.from;

	if (input.from !== undefined && from !== "user" && !thread.persons.includes(from))
		throw new Error(`Person ${from} is not in thread ${thread.id}`);
	const at = input.at ?? found.at;
	const fields = { id: found.id, thread: thread.id, from, at, text: input.text, by };
	let message: FileMessage;

	if (from !== "user") message = { ...fields, direction: "in", state: "received" };
	else if (found.direction === "out")
		message = { ...fields, direction: "out", state: found.state, changed: found.changed };
	else message = { ...fields, direction: "out", state: "draft", changed: { at, by } };

	tx.putMessage(message);
	setLast(tx, thread.id);

	return replyMessage(message);
}

/**
 * Removes the message `input.message`, and gives it as it was. A rule that is not retired and has it as its source
 * fails the delete, and a retired rule with it as its source loses its source. The `last` of the thread becomes the
 * latest time of the messages that remain, and goes when none remains.
 */
export function deleteMessage(tx: StoreTx, input: MessageDelete): Message {
	const found = tx.message(input.message);
	releaseSource(tx, found.id);
	tx.removeMessage(found.id);
	setLast(tx, found.thread);

	return replyMessage(found);
}

/** Sets the `last` of the thread `thread` to the latest time of its messages, or removes it when there is none. */
function setLast(tx: StoreTx, thread: number): void {
	const times = tx.messages(thread).map((message) => message.at);

	tx.setLast(thread, times.length === 0 ? undefined : Math.max(...times));
}

/** Moves each message out of the thread `thread` that is not later than `at` with a reply by the caller `by`. */
function reply(tx: StoreTx, thread: number, at: number, by: string): void {
	const now = Date.now();

	for (const out of tx.outMessages(thread)) {
		const state = out.at <= at ? messageTransition(out.state, "reply") : undefined;

		if (state !== undefined) tx.putMessage({ ...out, state, changed: { at: now, by } });
	}
}

/**
 * Marks the message out `input.message` with `input.state` for the caller `by`, and gives it. A message in, and a mark
 * that its state cannot take, fail.
 */
export function markMessage(tx: StoreTx, input: MessageMarkInput, by: string): Message {
	const { message: id } = input;
	const out = tx.message(id);

	if (out.direction === "in") throw new Error(`Message ${id} is a message in: only a message out has a mark`);
	const state = messageTransition(out.state, input.state);

	if (state === undefined) throw new Error(`Message ${id} is ${out.state}: it cannot become ${input.state}`);
	const marked: FileMessage = { ...out, state, changed: { at: Date.now(), by } };
	tx.putMessage(marked);

	return replyMessage(marked);
}

/** The thread `id` and its messages, oldest first. */
export function readThread(store: StoreReader, id: number): ThreadMessages {
	return { thread: store.thread(id), messages: store.messages(id).map(replyMessage) };
}
