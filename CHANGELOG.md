# Changelog

## 0.0.1 (2026-11-27)


### ⚠ BREAKING CHANGES

* the gate and held requests are gone, and Pi sessions run their tool calls with no gate. projects store load reads only store files of version 3.
* a host that starts with a store.json and no project.sqlite starts with an empty store. To load the file, run projects store load.

### Features

* add the project memory and the memory tool to the projects entry ([c39db8d](https://github.com/Vzlentin/projects/commit/c39db8d4358ef4c9fd082bf7679a1eb75bfe74fc))
* add the projects CLI with rule, item, parley and store load ([6ea156d](https://github.com/Vzlentin/projects/commit/6ea156d2f7de2140f70b4e833c7d3372128002a1))
* add the projects entry with its protocol, store, tools, gate and digest ([9f4fa95](https://github.com/Vzlentin/projects/commit/9f4fa95b584cb537ef80ce745727c010dcb37378))
* delete the store.json import at the first start ([200589d](https://github.com/Vzlentin/projects/commit/200589d18c8a071f3c794a08255c962c521de5e2))
* make an open parley with a round that has a new slug and no asks ([cbdfff7](https://github.com/Vzlentin/projects/commit/cbdfff729330d36a8a0a5fc4b8b717ba0cf75d56))
* **pi:** add pi-projects with the project tools, /rules, the gate, memory, /drafts and the parley skill ([cbb133d](https://github.com/Vzlentin/projects/commit/cbb133d5fb8d3c9ad3b88ba3b3b7c2d13899a1e8))
* print a parley round in one shape, with a context text and a view for each call ([ee5ee4f](https://github.com/Vzlentin/projects/commit/ee5ee4f14a61090c701b470136663aa5cb04240b))
* remove the gate and the held actions ([59da734](https://github.com/Vzlentin/projects/commit/59da734528261abc2ea61b13e1c7207e74a8d2fe))
* replace an ask through the harness handle, and end an open parley as dropped ([6512345](https://github.com/Vzlentin/projects/commit/6512345573c006dabbe76b6f95af7baae9fc34cf))
* replace an open ask in a round, and record a rule from the words of the user ([3b9acde](https://github.com/Vzlentin/projects/commit/3b9acde427eed76d21f4526855a2a813c9f52943))


### Bug Fixes

* load only the project lists with store load ([2512703](https://github.com/Vzlentin/projects/commit/251270313aeea108d740acb28aa5396d8267dd39))


### Miscellaneous Chores

* release 0.0.1 first ([bbc3892](https://github.com/Vzlentin/projects/commit/bbc3892a0925dfb1021841d362a7313beec08f42))
