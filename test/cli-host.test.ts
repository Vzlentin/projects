import { writeFile } from "node:fs/promises";
import { entriesPath } from "@vzlentin/harness/entries";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHost, projects, setUp, startHost, tearDown } from "./helpers.ts";

beforeAll(setUp);

afterAll(tearDown);

describe("the host of a projects command", { timeout: 60_000 }, () => {
	it("is --host, else HARNESS_HOST, else the host of the cwd", async () => {
		const dirA = await createHost("a");
		const dirB = await createHost("b");
		const hostA = await startHost("a");
		const hostB = await startHost("b");

		try {
			expect(await projects(["--host", "a", "item", "add", "In a"], {}, dirB)).toMatchObject({ code: 0, stderr: "" });
			expect(await projects(["item", "add", "In b"], {}, dirB)).toMatchObject({ code: 0, stderr: "" });

			const [listA, listB, byEnv, byOption, optionAfter, unknown, project] = await Promise.all([
				projects(["item"], {}, dirA),
				projects(["item"], {}, dirB),
				// --host wins over HARNESS_HOST, which wins over the cwd.
				projects(["item"], { HARNESS_HOST: "b" }, dirA),
				projects(["--host", "a", "item"], { HARNESS_HOST: "b" }, dirB),
				// After the command, --host is an argument of that command, not the host.
				projects(["item", "list", "--host", "a"], {}, dirB),
				projects(["--host", "nope", "item"]),
				projects(["--project", "a", "item"], {}, dirB),
			]);

			expect(listA).toEqual({ code: 0, stdout: "○ 1 inbox In a\n", stderr: "" });
			expect(listB).toEqual({ code: 0, stdout: "○ 1 inbox In b\n", stderr: "" });
			expect(byEnv).toEqual(listB);
			expect(byOption).toEqual(listA);
			expect(optionAfter).toEqual({ code: 1, stdout: "", stderr: "Unknown item argument: --host\n" });
			expect(unknown).toEqual({ code: 1, stdout: "", stderr: "Unknown harness host: nope\n" });
			expect(project).toEqual({ code: 1, stdout: "", stderr: "projects takes --host <name>, not --project\n" });
		} finally {
			await hostA.close();
			await hostB.close();
		}
	});

	it("fails with one line when the host does not load the projects entry", async () => {
		await createHost("bare");
		await writeFile(entriesPath(), "{}");
		const host = await startHost("bare");

		try {
			expect(await projects(["--host", "bare", "item"])).toEqual({
				code: 1,
				stdout: "",
				stderr: 'no loaded entry serves request type "item"\n',
			});
		} finally {
			await host.close();
		}
	});
});
