# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bebek-gg/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bebek-gg/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, to one written specification (SPEC.md, in the kit). It finds the lines an edit names even when the model drifted their whitespace or indentation, matching at three tiers (exact, trailing whitespace, leading and trailing whitespace with re-indentation), and changes every file or none: a failed edit changes nothing, and every failure is reported.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input. `--format` reads the patch in one format (`unified`, `search-replace`, `v4a`, `json`); `auto`, the default, detects it. `--check` does everything but write. `--strict` matches lines exactly (tier 0 only). Node 22 and its standard library only; nothing is installed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x6dyrps0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
