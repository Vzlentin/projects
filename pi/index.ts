/**
 * The `thread`, `rule`, `parley` and `item` tools of the store of the project, the digest and the rules section, the
 * `memory` tool and the memory section, `/rules`, and `/drafts`, which copies a draft of a thread and marks it sent.
 * They use the modules of `@vzlentin/projects`, the dependency of this package, from its built `dist/`, and the harness
 * of that package, whose client starts the host of that install. The `.bin` folder that holds its `projects` command
 * goes last on `PATH`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDrafts } from "./drafts.ts";
import { registerMemory } from "./memory.ts";
import { registerProject } from "./project.ts";
import { registerRules } from "./rules.ts";

/** The modules of the projects install that the extension uses, with the harness modules of that install. */
export type Projects = {
	readonly client: typeof import("@vzlentin/harness/client");
	readonly tool: typeof import("@vzlentin/harness/tool");
	readonly protocol: typeof import("@vzlentin/harness/protocol");
	readonly projectTool: typeof import("../src/project-tool.ts");
	readonly memoryTool: typeof import("../src/memory-tool.ts");
	readonly projectProtocol: typeof import("../src/protocol/project.ts");
	readonly requests: typeof import("../src/protocol/requests.ts");
};

const PROJECTS_PACKAGE = "@vzlentin/projects";

export default async function projectsExtension(pi: ExtensionAPI): Promise<void> {
	const require = createRequire(import.meta.url);
	putProjectsBinLast(require);
	const projects = await loadProjects(require);
	registerProject(pi, projects);
	registerMemory(pi, projects);
	registerRules(pi, projects);
	registerDrafts(pi, projects, copyToClipboard);
}

/**
 * Puts the `.bin` folder next to the projects package last on `PATH`, so Pi's tools find `projects`. It goes last
 * because the folder also holds the commands of other dependencies, such as an older `pi`, which must not hide the
 * user's own. It removes the folder first, so each load of the extension leaves it on `PATH` once.
 */
function putProjectsBinLast(require: NodeJS.Require): void {
	const modules = require.resolve
		.paths(PROJECTS_PACKAGE)
		?.find((dir) => existsSync(join(dir, PROJECTS_PACKAGE, "package.json")));

	if (modules === undefined) return;
	const bin = join(modules, ".bin");
	const rest = process.env.PATH ? process.env.PATH.split(delimiter).filter((entry) => entry !== bin) : [];
	process.env.PATH = [...rest, bin].join(delimiter);
}

/**
 * Loads the modules of the projects package that this extension resolves, and the harness modules that this package
 * imports. Another copy of harness, such as an older one of pi-agents that npm can hoist, may not have the same modules
 * or behave the same. A module that does not load makes the extension fail.
 */
async function loadProjects(require: NodeJS.Require): Promise<Projects> {
	const fromProjects = createRequire(require.resolve(`${PROJECTS_PACKAGE}/package.json`));

	const specifiers = [
		"@vzlentin/harness/client",
		"@vzlentin/harness/tool",
		"@vzlentin/harness/protocol",
		`${PROJECTS_PACKAGE}/project-tool`,
		`${PROJECTS_PACKAGE}/memory-tool`,
		`${PROJECTS_PACKAGE}/protocol/project`,
		`${PROJECTS_PACKAGE}/protocol/requests`,
	];

	const [client, tool, protocol, projectTool, memoryTool, projectProtocol, requests] = await Promise.all(
		specifiers.map((specifier) => import(pathToFileURL(fromProjects.resolve(specifier)).href)),
	);

	// SAFETY: these are the built modules of the projects package and of its harness, whose declarations the `Projects`
	// type comes from.
	return { client, tool, protocol, projectTool, memoryTool, projectProtocol, requests } as Projects;
}
