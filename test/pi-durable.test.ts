import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request, requestEntry } from "@vzlentin/harness/client";
import { entriesPath } from "@vzlentin/harness/entries";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PROJECTS_PROTOCOL_VERSION } from "../src/projects/index.ts";
import { RuleList } from "../src/protocol/project.ts";
import { root, setUp, startHost, tearDown } from "./helpers.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

beforeEach(setUp);

afterEach(tearDown);

/**
 * Installs pi-projects as Pi installs an npm package, in `<agent dir>/npm/node_modules`, with `@vzlentin/projects` as
 * this checkout and its built `dist/`, and lists it in the packages of Pi's settings.
 */
async function installPiProjects(): Promise<void> {
	const agentDir = join(root, "agent");
	const modules = join(agentDir, "npm", "node_modules", "@vzlentin");
	const piProjects = join(modules, "pi-projects");
	await mkdir(piProjects, { recursive: true });

	for (const file of ["package.json", "entry.js"]) await copyFile(join(REPO, "pi", file), join(piProjects, file));
	await symlink(REPO, join(modules, "projects"));
	const settingsPath = join(agentDir, "settings.json");
	const settings: object = JSON.parse(await readFile(settingsPath, "utf8"));
	await writeFile(settingsPath, JSON.stringify({ ...settings, packages: ["npm:@vzlentin/pi-projects"] }));
}

describe("the Pi package", { timeout: 30_000 }, () => {
	it("makes a host load the projects entry from piDurable, with no entry in entries.json", async () => {
		await writeFile(entriesPath(), "{}");
		await installPiProjects();
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
});
