import { writeFile } from "node:fs/promises";
import { request, requestEntry } from "@vzlentin/harness/client";
import { entriesPath } from "@vzlentin/harness/entries";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PROJECTS_PROTOCOL_VERSION } from "../src/projects/index.ts";
import { RuleList } from "../src/protocol/project.ts";
import { setUp, startHost, tearDown } from "./helpers.ts";

beforeEach(setUp);

afterEach(tearDown);

describe("the projects entry", () => {
	it("gives its protocol version in hello and serves the rule requests when entries.json names it", async () => {
		const host = await startHost();

		try {
			const hello = await request({ type: "hello", version: 0, external: true }, { start: false });
			expect(hello?.entries.projects).toBe(PROJECTS_PROTOCOL_VERSION);

			const rules = await requestEntry({ type: "rule", action: "list" }, { start: false });
			expect(Value.Parse(RuleList, rules)).toEqual({ rules: [] });
		} finally {
			await host.close();
		}
	});

	it("is not loaded when entries.json does not name it", async () => {
		await writeFile(entriesPath(), "{}");
		const host = await startHost();

		try {
			const hello = await request({ type: "hello", version: 0, external: true }, { start: false });
			expect(hello?.entries.projects).toBeUndefined();

			await expect(requestEntry({ type: "rule", action: "list" }, { start: false })).rejects.toThrow(
				'no loaded entry serves request type "rule"',
			);
		} finally {
			await host.close();
		}
	});
});
