# Skill Scout — a DeepSeek Harness plugin

Before a project starts, find the skills it should use, let the user choose, and
keep a local record of the decision.

`Skill Scout` adds one Host-plane plugin to a DeepSeek Harness (DSH) profile:

- **`skill_scout`** — a tool that ranks the skills **this agent can actually
  load** against the project, returns at least three candidates, records the
  user's choice, re-searches on request, and writes an archive.
- **`project-skill-scout`** — a skill that carries the workflow: describe the
  project, discover, summarize with a multi-select question, re-search when the
  user is not satisfied, then load the chosen skills before working.

## Why

Starting a project with the wrong skills wastes a whole session; starting with no
skills wastes the ones you already have installed. Skill Scout makes the choice
explicit, keeps it auditable, and leaves behind a local archive so the next
project starts from what you learned.

## Behavior

| Action | What it does |
|---|---|
| `discover` | Ranks the live merged skill catalog (plus any externally found candidates you pass in `extra`) against the `project` sentence and `keywords`. Returns at least `minCandidates` (default 3) candidates with their source, address and match score. |
| `choose` | Records the names the user picked. Copies the **full source** of every used skill into the archive; keeps every unused candidate as an **address only**. |
| `status` | Reports rounds, the current choice, exclusions and archive paths for a project. |

Re-searching is the same `discover` call with `exclude` set to the names already
offered; the plugin also remembers what it has shown, so a later round never
repeats a rejected candidate.

### Archive layout

Default root `<DSH_HOME>/skill-scout` (override with the row's `config.archiveRoot`):

```
projects/<slug>/
  state.json      rounds, shown candidates, exclusions, final choice
  unused.md       ADDRESSES of the skills the user did not choose
  unused.jsonl    the same, machine-readable
  used/<name>/    FULL SOURCE COPY of each chosen skill
  used/index.md
```

Only chosen skills get their source copied. A chosen skill that is not installed
locally is recorded by address, and the archive says so instead of pretending to
have its source.

## Requirements

- DeepSeek Harness `0.2.0-rc.2` (or a compatible runtime)
- The `skills` and `tools` services, which the shipped `dsh-base` bundle mounts
- Python is **not** required; the plugin is plain ESM and has no runtime
  dependencies of its own

## Install

The supported path is the Harness plugin manager, which performs the package
install, the bundle selection and the reload:

```
plugin_manager  action: "install_bundle"
                target: "<absolute path to this directory>"
```

A GitHub spec works too, since `install_bundle` handles repository installs.

The **creating** session needs the `plugin_manager` tool, which the `standard`
preset disables — install from a session running the 创造模式 / `cordis` preset,
or install the bundle from the Web UI plugin manager. Do not hand-edit the
profile's `package.json` or `cordis.patch.yml`, and do not run pnpm inside the
profile directory.

Then verify, in order:

1. the `skill-scout` row is present and enabled;
2. `skill_scout` is visible to the agent;
3. `project-skill-scout` appears in the skill catalog;
4. one real `discover` → `choose` round writes `unused.md` and a real
   `used/<name>/` source copy on disk.

## Configure

```yaml
- id: skill-scout
  name: '@local/dsh-skill-scout'
  config:
    minCandidates: 3          # minimum candidates per round
    archiveRoot: ''           # default: <DSH_HOME>/skill-scout
```

## Development

```
node --check index.js
node test/core.test.mjs      # 8 checks over the pure half
```

`core.js` holds the ranking, state store and archive writer and imports nothing
from the Harness, which is what makes those checks possible. `index.js` is the
thin Host half: tool registration plus the embedded skill.

## Design notes

- Candidates come from `ctx.skills.list({ scope: exec.agent, ... })`, so a
  candidate is always something the calling agent can actually load. Ecosystem
  search (`npx skills find`, skills.sh) is done **by the agent** and fed in
  through `extra`; the tool never shells out behind your back.
- The user chooses. The tool never auto-selects, and the skill requires a
  multi-select question rather than a silent assumption.
- A round never returns fewer candidates than it can honestly supply: when the
  sources cannot produce three, the output says so instead of padding the list.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

**Skill Scout** 是一个 DeepSeek Harness 插件，解决"项目开始前该用哪些技能"：

- 项目开始前，按项目描述对**这个 agent 真正可见的技能目录**排序，给出至少三个候选；
- 总结后交给你用多选问题挑选，绝不替你决定；
- 不满意就用同样的调用加 `exclude` 重新找，不会重复推荐已展示过的候选；
- 选完后本地存档：**未使用**的技能只存地址（URL / 安装命令 / 本地 SKILL.md 路径），**已使用**的技能把整个技能目录完整拷贝进存档。

存档默认在 `<DSH_HOME>/skill-scout`，可用行配置里的 `archiveRoot` 改。

安装用 Harness 的插件管理器（`plugin_manager` → `install_bundle`，`target` 指向本目录绝对路径）。注意 `standard` preset 禁用了 `plugin_manager` 工具，需要在创造模式（`cordis` preset）的会话里安装，或在 Web UI 的插件页安装。
