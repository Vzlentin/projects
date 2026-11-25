# projects

The project store of the harness stack: persons, threads, rules, parleys, work items and the digest, as an entry of a [harness](https://github.com/Vzlentin/harness) host.
It is part of the harness stack, with [harness](https://github.com/Vzlentin/harness) and [workflows](https://github.com/Vzlentin/workflows).

## Install

You need Node.js 22.19 or later.

With Pi:

```sh
pi install npm:@vzlentin/pi-projects
```

Pi installs `@vzlentin/projects` and its harness with it, in its own npm folder. The `piDurable` field of pi-projects makes the harness host load the projects entry, so you do not change `entries.json`.

For the `projects` command in a terminal, add this line to your shell profile. The folder goes last, because it also holds the commands of other dependencies, such as an older `pi`:

```sh
export PATH="$PATH:$HOME/.pi/agent/npm/node_modules/.bin"
```

Without Pi, install the package with npm, and name its entry in `$XDG_CONFIG_HOME/harness/entries.json`:

```sh
npm install -g @vzlentin/projects
```

```json
{ "projects": "/path/to/node_modules/@vzlentin/projects/dist/projects/index.js" }
```

Use one of the two, not both. When `entries.json` names the entry and pi-projects is also installed, the host loads two projects entries and refuses to start. A host that runs loads a new entry only after it starts again. It stops by itself after 5 minutes with no work.

To update with Pi: `pi update --extensions`, then `/reload`. The stack releases harness first, then workflows and projects, each with a harness version that takes the new one.

## Use

- `projects`: the CLI of the store, with `rule`, `item`, `parley` and `store load`. `projects` with no command prints the usage.
- The `thread`, `rule`, `parley` and `item` tools, and the `memory` tool, in each Pi session.
- The digest of the session before each turn, and the decided rules and the memory of the host agent in the system prompt.
- `/rules`: list the rules of the project, and decide, retire, edit, create or delete one.
- `/drafts`: copy a draft of a thread to the clipboard, and mark it sent.
- The `parley` skill: the conduct of a parley with the `parley` tool.

`docs/spec.md` gives the requests, tools and behaviour.

## Development

```sh
npm ci
npx vp check --fix
npm run check
```
