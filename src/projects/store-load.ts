/**
 * `projects store load <file>`: writes the lists and the items of a store file into the empty `project.sqlite` of a
 * host, while no host runs, with the import of the first start of a host. It refuses a file with asks or todos, which
 * belong to the harness host.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "@vzlentin/harness/lock";
import { STORE_LOCK_WAIT_MS, statePaths } from "@vzlentin/harness/protocol";
import { isMovedTodo } from "../protocol/item-move.ts";
import { parseStoreFile, type StoreCounts, storeCounts, type StoreFile } from "../protocol/store-file.ts";
import { PROJECT_STORE_FILE, ProjectStore, type StoreReader } from "./project-store.ts";
import { importStoreFile, loadStoreFile } from "./store-import.ts";

/**
 * Writes the lists of the store file at `path` into the project store of the host `host`, under the lock of the host,
 * and gives the count of each list. The persons, the threads, the messages, the rules, the parleys and the items keep
 * the IDs of the file. A failure leaves no `project.sqlite` when there was none. It fails before it writes when the
 * file is not a store file, when the file has asks or todos, when a host runs for `host`, or when a list of
 * `project.sqlite` is not empty. An empty `project.sqlite` keeps its ID counters and its deliveries.
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
				await importStoreFile(dir, file);
			} else if (isEmpty(store)) {
				await loadStoreFile(store, file);
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

/** Whether each list of `store` is empty. Its ID counters and its deliveries do not count. */
function isEmpty(store: StoreReader): boolean {
	const lists = [store.persons(), store.threads(), store.rules({}), store.held(), store.parleys(), store.items()];

	return lists.every((list) => list.length === 0);
}
