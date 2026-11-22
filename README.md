# projects

The project store of the harness stack: persons, threads, rules, parleys, work items, the gate and the digest, as an entry of a [harness](https://github.com/Vzlentin/harness) host.
It is part of the harness stack, with [harness](https://github.com/Vzlentin/harness) and [workflows](https://github.com/Vzlentin/workflows).

## Use

`@vzlentin/projects/entry` is the projects entry. A harness host loads it when `$XDG_CONFIG_HOME/harness/entries.json` names its module:

```json
{ "projects": "/path/to/node_modules/@vzlentin/projects/dist/projects/index.js" }
```

`docs/spec.md` gives its requests, tools and behaviour.

## Development

```sh
npm ci
npx vp check --fix
npm run check
```
