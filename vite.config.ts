import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineConfig } from "vite-plus";
import type { OxlintOverride } from "vite-plus/lint";

/** A `no-restricted-imports` pattern: the import paths that match `group` or `regex`. */
type ImportPattern = { message: string; allowTypeImports?: boolean } & ({ group: string[] } | { regex: string });

/** An override that refuses, in `files`, the imports that match one of `patterns`. */
function restrictImports(files: string[], ...patterns: ImportPattern[]): OxlintOverride {
	return { files, rules: { "no-restricted-imports": ["error", { patterns }] } };
}

/** The `exports` of a `package.json`: each subpath, with its file, or with the file of its types and of its code. */
const Manifest = Type.Object({
	exports: Type.Record(Type.String(), Type.Union([Type.String(), Type.Object({ default: Type.String() })])),
});

/** The subpaths that the installed `@vzlentin/harness` exports, such as `./entry-api`. */
const HARNESS_SUBPATHS = Object.keys(
	Value.Parse(
		Manifest,
		JSON.parse(readFileSync(new URL("node_modules/@vzlentin/harness/package.json", import.meta.url), "utf8")),
	).exports,
);

/** Harness only through the subpaths that it exports: no deep import into its `dist/` or `src/`. */
const harnessImports: ImportPattern = {
	group: ["@vzlentin/harness/**", ...HARNESS_SUBPATHS.map((subpath) => `!@vzlentin/harness/${subpath.slice(2)}`)],
	message: "Import @vzlentin/harness only through a subpath of its exports, such as @vzlentin/harness/entry-api.",
};

export default defineConfig({
	fmt: {
		useTabs: true,
		printWidth: 120,
		singleQuote: false,
		sortImports: { newlinesBetween: false },
		ignorePatterns: [
			"dist/**",
			"tools/oxlint/anti-slop/**",
			".release-please-manifest.json",
			"CHANGELOG.md",
			// A copy of the cases of the gate spike, kept as it was recorded.
			"test/fixtures/gate-cases.json",
		],
	},
	lint: {
		ignorePatterns: [
			".agent/**",
			".agents/**",
			".claude/**",
			".codex/**",
			".continue/**",
			".cursor/**",
			".gemini/**",
			".opencode/**",
			".pi/**",
			".roo/**",
			".windsurf/**",
			"tools/oxlint/anti-slop/**",
			"dist/**",
		],
		jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
		rules: {
			"oxc/no-accumulating-spread": "error",
			"anti-slop/no-array-filter-map": "error",
			"anti-slop/no-reduce-accumulator-copy": "error",
			"anti-slop/no-chained-type-assertions": "error",
			"anti-slop/no-conditional-empty-object-spread": "error",
			"anti-slop/no-known-value-widening": "error",
			"anti-slop/no-module-mocking": "error",
			"anti-slop/no-object-parameters": "error",
			"anti-slop/no-reflect-apply": "error",
			"anti-slop/no-reflect-get": "error",
			"anti-slop/no-runtime-typeof": "error",
			"anti-slop/no-shape-in-symbol-names": "error",
			"anti-slop/no-unknown-parameters": "error",
			"anti-slop/no-unknown-returns": "error",
			"anti-slop/no-unknown-type-aliases": "error",
			"anti-slop/no-unsafe-dictionary-type": "error",
			"anti-slop/no-widen-then-assert": "error",
			"anti-slop/require-readable-spacing": "error",
			"anti-slop/require-safety-comment-for-type-assertion": "error",
		},
		overrides: [
			restrictImports(["src/**", "test/**", "pi/**"], harnessImports),
			// An override replaces the rule config of the earlier one, so the Pi package repeats `harnessImports`. It comes last:
			// its `!` subpaths would let a runtime import of an exported harness subpath pass the pattern before it.
			restrictImports(
				["pi/**"],
				{
					regex: "^\\.\\./(src|dist)/",
					allowTypeImports: true,
					message:
						"The Pi package loads the modules of @vzlentin/projects at runtime: import ../src or ../dist only for types.",
				},
				{
					regex: "^@vzlentin/harness/",
					allowTypeImports: true,
					message:
						"The Pi package loads harness from the folder of @vzlentin/projects at runtime: import @vzlentin/harness only for types.",
				},
				harnessImports,
			),
		],
		options: { typeAware: true, typeCheck: true },
	},
	test: {
		// The tests change `process.env`, such as `HOME`, so each test file runs in its own process.
		// `test/setup.ts` clears the caller's `GIT_*` variables in each of these processes.
		pool: "forks",
		setupFiles: ["test/setup.ts"],
		// Vite transforms harness, so the hosts of the tests load the entry of this checkout in the module graph of the tests.
		server: { deps: { inline: ["@vzlentin/harness"] } },
	},
	pack: {
		entry: ["src/**/*.ts"],
		outDir: "dist",
		format: ["esm"],
		platform: "node",
		unbundle: true,
		fixedExtension: false,
		dts: true,
		deps: { neverBundle: true },
	},
});
