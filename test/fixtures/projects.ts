/**
 * An entry that loads the projects entry and keeps the handles of the host, for the tests that need a handle that the
 * harness package does not export, such as the asks or the todos.
 */
import type { Entry, EntryHandles, EntryOptions } from "@vzlentin/harness/entry-api";
import projects from "../../src/projects/index.ts";

let handles: EntryHandles | undefined;

/** The handles of the last host that loaded this entry. It throws when no host loaded it. */
export function fixtureHandles(): EntryHandles {
	if (handles === undefined) throw new Error("No host loaded the projects fixture entry");

	return handles;
}

export default function projectsFixture(options: EntryOptions): Entry {
	handles = options;

	return projects(options);
}
