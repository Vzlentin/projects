/**
 * `projects store load <file>`: writes the lists and the items of a store file into the empty stores of a host
 * (`durable.sqlite` and `project.sqlite`), while no host runs, with the import of the first start of a host.
 *
 * The asks and the lists of todos are documents of the harness host, and harness exports no handle to them that works
 * without a running host. So this module defines its own copies of the four documents that it reads and writes:
 * `harness.asks`, `harness.todos`, `harness.caller-todos` and `harness.save-todos`, with the same kinds, versions,
 * scopes and initial values as the pinned harness.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineDocFamily,
	type DocumentReader,
	Harness,
	ROOT_CONVERSATION_ID,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { boundedReplay } from "@vzlentin/harness/checkpoint";
import { takeLock } from "@vzlentin/harness/lock";
import {
	ASKS_KIND,
	type AskList,
	STORE_LOCK_WAIT_MS,
	statePaths,
	TODO_LIST_KIND,
	type Todo,
	type TodoList,
} from "@vzlentin/harness/protocol";
import { readCallerTodos, readTodos } from "@vzlentin/harness/todo";
import { parseStoreFile, type StoreCounts, storeCounts, type StoreFile } from "../protocol/store-file.ts";
import { PROJECT_STORE_FILE, ProjectStore } from "./project-store.ts";
import { readStoreFile } from "./store-file.ts";
import { importStoreFile, loadStoreFile } from "./store-import.ts";

const context = BACKGROUND_CONTEXT;

/** The asks of the store, in ID order. */
const Asks = defineDoc<AskList>({
	kind: ASKS_KIND,
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ asks: [] }),
});

/** The list of todos of a conversation. */
const ConversationTodos = defineDoc<TodoList>({
	kind: TODO_LIST_KIND,
	version: 1,
	scope: "conversation",
	history: "latest",
	checkpointWhen: boundedReplay,
	fork: "initial",
	initial: () => ({ todos: [] }),
});

/** The list of todos of a caller that is not a conversation of the host, by caller. */
const CallerTodos = defineDocFamily<TodoList, null>({
	kind: "harness.caller-todos",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	family: true,
	initial: () => ({ todos: [] }),
});

/** Whose list of todos the load writes: the root conversation, or a caller that is not a conversation of the host. */
type LoadOwner = { kind: "conversation"; id: ConversationId } | { kind: "caller"; caller: string };

/** The links of the asks that have a todo to the list that holds the todo. */
const Links = defineDoc<{ links: { ask: number; owner: LoadOwner }[] }>({
	kind: "harness.save-todos",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ links: [] }),
});

/** Reads the asks of the store, as the asks handle of a host does. */
async function readAsks(reader: Pick<DocumentReader, "snapshot">, read: Context): Promise<AskList> {
	return { asks: structuredClone((await reader.snapshot(Asks, read))?.asks ?? []) };
}

/** Reads the list of the conversation `id`, as the todos handle of a host does. */
function readConversationTodos(
	reader: Pick<DocumentReader, "snapshot">,
	id: ConversationId,
	read: Context,
): Promise<TodoList> {
	return readTodos(reader, { kind: "conversation", id }, read);
}

/**
 * Writes the lists of the store file at `path` into the stores of the host `host`, under the lock of the host, and
 * gives the count of each list. The persons, the threads, the messages, the rules, the parleys and the items keep the
 * IDs of the file. The two stores are written as one: the write into `project.sqlite` stays open across the commit of
 * `durable.sqlite`, and a commit that fails rolls it back, or leaves no `project.sqlite` when there was none. It fails
 * before it writes when the file is not a store file, when a host runs for `host`, or when a list of the stores is not
 * empty. An empty `project.sqlite` keeps its ID counters and its deliveries.
 */
export async function loadStore(host: string, path: string): Promise<StoreCounts> {
	const file = parseStoreFile(path);
	const { dir } = statePaths(host);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = takeLock(dir);

	if (lock === undefined) {
		throw new Error(`A harness host runs for ${host}: stop it, then run projects store load again`);
	}

	try {
		const durable = join(dir, "durable.sqlite");

		const writeDurable = () =>
			withHarness(durable, false, async (harness) => {
				await writeFile(harness, file);

				return (await readAsks(harness, context)).asks;
			});

		// The check opens `project.sqlite` only when it exists, so a failed load leaves none.
		const store = existsSync(join(dir, PROJECT_STORE_FILE)) ? ProjectStore.open(dir, STORE_LOCK_WAIT_MS) : undefined;

		try {
			// A read-only open recovers nothing, so a store that is not empty stays as it is.
			const lists = await withHarness(durable, true, (harness, storage) =>
				readStoreFile(harness, storage, ROOT_CONVERSATION_ID, {
					store,
					asks: { read: readAsks },
					todos: { read: readConversationTodos, callers: readCallerTodos },
				}),
			);

			if (Object.values(storeCounts(lists)).some((count) => count > 0)) {
				throw new Error(`The store of ${host} is not empty: projects store load writes only into an empty store`);
			}

			if (store === undefined) {
				await importStoreFile(dir, file, writeDurable);
			} else {
				await loadStoreFile(store, file, writeDurable);
			}
		} finally {
			store?.close();
		}

		return storeCounts(file);
	} finally {
		lock.close();
	}
}

/** The list of todos of `owner` in `tx`, which the read creates when it is missing. */
function draftOf(tx: Tx, owner: LoadOwner): Promise<TodoList> {
	return owner.kind === "conversation" ? tx.doc(ConversationTodos, owner.id) : tx.doc(CallerTodos, owner.caller, null);
}

/** Adds a copy of `todo` to the list of `owner` in `tx`, and the link of its ask to that list when it has one. */
async function pushTodo(tx: Tx, owner: LoadOwner, todo: Todo): Promise<void> {
	(await draftOf(tx, owner)).todos.push({ ...todo });

	if (todo.ask !== undefined) (await tx.doc(Links)).links.push({ ask: todo.ask, owner });
}

/**
 * Writes the asks of `file`, the list of the root conversation and the list of each caller, also an empty one, in
 * `tx`.
 */
async function writeLists(tx: Tx, file: StoreFile): Promise<void> {
	(await tx.doc(Asks)).asks.push(...file.asks);
	const root: LoadOwner = { kind: "conversation", id: ROOT_CONVERSATION_ID };
	await draftOf(tx, root);

	for (const todo of file.todos) await pushTodo(tx, root, todo);

	for (const list of file.callerTodos) {
		const owner: LoadOwner = { kind: "caller", caller: list.caller };
		await draftOf(tx, owner);

		for (const todo of list.todos) await pushTodo(tx, owner, todo);
	}
}

/**
 * Writes the lists of `file` that `durable.sqlite` keeps, the asks and the lists of todos, in one commit: the commit
 * that creates the root conversation when the store has none.
 */
async function writeFile(harness: Harness, file: StoreFile): Promise<void> {
	const write = (tx: Tx) => writeLists(tx, file);

	if ((await harness.conversation(ROOT_CONVERSATION_ID, context)) === undefined) {
		await harness.root(context, { init: write });
	} else {
		await harness.commit(write, context);
	}
}

/** Runs `use` on the harness of the store at `path`, and closes it. */
async function withHarness<T>(
	path: string,
	readOnly: boolean,
	use: (harness: Harness, storage: Storage) => Promise<T>,
): Promise<T> {
	const storage = await openNodeSqliteStorage(path, { busyTimeoutMs: STORE_LOCK_WAIT_MS });

	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry: createRegistry(), readOnly },
		context,
	);

	try {
		return await use(harness, storage);
	} finally {
		await harness.close(context);
	}
}
