/**
 * `projects store load <file>`: writes the lists and the items of a store file into the empty `project.sqlite` of a
 * host, while no host runs. It refuses a file with asks or todos, which belong to the harness host. It creates
 * `project.sqlite` only once its write commits.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "@vzlentin/harness/lock";
import { STORE_LOCK_WAIT_MS, statePaths } from "@vzlentin/harness/protocol";
import { isMovedTodo } from "../protocol/item-move.ts";
import { parseStoreFile, type StoreCounts, storeCounts, type StoreFile } from "../protocol/store-file.ts";
import { PROJECT_STORE_FILE, ProjectStore, type StoreReader } from "./project-store.ts";

/** The file that the load writes, which becomes `project.sqlite` after its commit. */
const LOAD_FILE = `${PROJECT_STORE_FILE}.import`;

/** The files that SQLite keeps beside a database file. */
const SIDE_FILES = ["", "-wal", "-shm", "-journal"];

/**
 * Writes the lists of the store file at `path` into the project store of the host `host`, under the lock of the host,
 * and gives the count of each list. The persons, the threads, the messages, the rules, the parleys and the items keep
 * the IDs of the file. A failure leaves no `project.sqlite` when there was none. It fails before it writes when the
 * file is not a store file, when the file has asks or todos, when a host runs for `host`, or when a list of
 * `project.sqlite` is not empty. An empty `project.sqlite` keeps its ID counters.
 */
export async function loadStore(host: string, path: string): Promise<StoreCounts> {
	const file = parseStoreFile(path);

	if (hasHostLists(file)) {
		throw new Error(
			`${path} has asks or todos: they belong to the harness host, and projects store load does not load them`,
		);
	}

	const { dir } = statePaths(host);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = takeLock(dir);

	if (lock === undefined) {
		throw new Error(`A harness host runs for ${host}: stop it, then run projects store load again`);
	}

	try {
		// The check opens `project.sqlite` only when it exists, so a failed load leaves none.
		const store = existsSync(join(dir, PROJECT_STORE_FILE)) ? ProjectStore.open(dir, STORE_LOCK_WAIT_MS) : undefined;

		try {
			if (store === undefined) {
				await loadNewStore(dir, file);
			} else if (isEmpty(store)) {
				await writeStoreFile(store, file);
			} else {
				throw new Error(`The store of ${host} is not empty: projects store load writes only into an empty store`);
			}
		} finally {
			store?.close();
		}

		return storeCounts(file);
	} finally {
		lock.close();
	}
}

/**
 * Writes `file` into a new `project.sqlite` in `dir`, which has none, with `writeStoreFile`. The file becomes
 * `project.sqlite` only after the commit. A failure leaves no `project.sqlite`.
 */
async function loadNewStore(dir: string, file: StoreFile): Promise<void> {
	removeDatabase(join(dir, LOAD_FILE));

	try {
		const store = ProjectStore.open(dir, 0, LOAD_FILE);

		try {
			await writeStoreFile(store, file);
		} finally {
			store.close();
		}

		renameSync(join(dir, LOAD_FILE), join(dir, PROJECT_STORE_FILE));
	} catch (error) {
		removeDatabase(join(dir, LOAD_FILE));
		throw error;
	}
}

/**
 * Writes the persons, the threads with their messages, the rules, the parleys and the items with their edges of
 * `file` into `store` in one transaction, with the IDs of the file. A failure rolls `store` back. The write tells no
 * listener. A rule with a source gets the thread of its source message. The highest ID that a rule had becomes
 * `lastRule`, and the highest ID that an item had `lastItem`, when it is higher. It always writes the counter of the
 * IDs of items.
 */
async function writeStoreFile(store: ProjectStore, file: StoreFile): Promise<void> {
	await store.transaction(async (tx) => {
		const threads = new Map<number, number>();

		for (const person of file.persons) tx.addPerson(person);

		for (const { messages, ...thread } of file.threads) {
			tx.addThread(thread);

			for (const message of messages) {
				tx.addMessage(message);
				threads.set(message.id, thread.id);
			}
		}

		for (const { thread: _, ...rule } of file.rules) {
			const thread = rule.source === undefined ? undefined : threads.get(rule.source);
			tx.addRule(thread === undefined ? rule : { ...rule, thread });
		}

		tx.raiseLastRule(file.lastRule);

		for (const parley of file.parleys) tx.addParley(parley);
		tx.loadItems(file.items, file.lastItem);
	});
}

/**
 * Whether `file` has an ask, a todo of the list of the project that the move to items did not make, or a todo of a
 * caller.
 */
function hasHostLists(file: StoreFile): boolean {
	return (
		file.asks.length > 0 ||
		file.todos.some((todo) => !isMovedTodo(todo)) ||
		file.callerTodos.some((list) => list.todos.length > 0)
	);
}

/** Whether each list of `store` is empty. Its ID counters do not count. */
function isEmpty(store: StoreReader): boolean {
	const lists = [store.persons(), store.threads(), store.rules({}), store.parleys(), store.items()];

	return lists.every((list) => list.length === 0);
}

/** Removes the database `path` and the files that SQLite keeps beside it. */
function removeDatabase(path: string): void {
	for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true });
}
