/**
 * An entry that loads the projects entry and keeps the handles of the host, for the tests that need a handle that the
 * harness package does not export, such as the asks, the todos or the classifier. A test can also replace `deliver`,
 * such as to make the tell of an approve fail.
 */
import type { Entry, EntryHandles, EntryOptions } from "@vzlentin/harness/entry-api";
import projects from "../../src/projects/index.ts";

/** A `deliver` in place of the one of the host, which gets the `deliver` of the host as `next`. */
type Deliver = (delivery: Parameters<EntryHandles["deliver"]>[0], next: EntryHandles["deliver"]) => Promise<void>;

let handles: EntryHandles | undefined;
let deliverOverride: Deliver | undefined;

/** The handles of the last host that loaded this entry. It throws when no host loaded it. */
export function fixtureHandles(): EntryHandles {
	if (handles === undefined) throw new Error("No host loaded the projects fixture entry");

	return handles;
}

/** Makes the projects entry call `deliver` in place of the `deliver` of the host, or the one of the host with none. */
export function replaceDeliver(deliver: Deliver | undefined): void {
	deliverOverride = deliver;
}

export default function projectsFixture(options: EntryOptions): Entry {
	handles = options;

	const deliver: EntryHandles["deliver"] = (delivery) =>
		deliverOverride === undefined ? options.deliver(delivery) : deliverOverride(delivery, options.deliver);

	return projects({ ...options, deliver });
}
