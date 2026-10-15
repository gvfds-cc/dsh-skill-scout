# Installing `@local/dsh-skill-scout`

This bundle is authored and self-checked. It is **not installed yet**: the session
that wrote it ran the `standard` preset, which disables `tool-plugin-manager`, so
that session had no `plugin_manager` tool. Install it from a session whose agent
preset is **创造模式 / cordis** (that preset mounts `plugin_manager` and the
`cordis_inspect_*` tools).

## The one call

```
plugin_manager  action: "install_bundle"
                target: "<absolute path to this directory>"
```

`install_bundle` performs the package install, the bundle selection and the
reload. Do **not** hand-write `profiles/web/package.json` or `cordis.patch.yml`,
do not create packages under `$DSH_HOME`, and do not run pnpm in the profile
directory.

Read the returned `application` and `warnings` fields — they decide whether the
change is live. Then verify with `cordis_inspect_query` (no approval needed)
rather than paging `list_plugins`.

## What it is

One Host-plane row (`skill-scout`) that provides the `skill_scout` tool and
registers the `project-skill-scout` workflow skill through
`ctx.skills.register()`. Because it registers in the global layer, every preset
in the `web` profile gets both.

| File | Role |
|---|---|
| `index.js` | Host plugin: the `skill_scout` tool + the embedded skill |
| `core.js` | Pure logic: ranking, state store, archive writer (no Harness imports) |
| `cordis.patch.yml` | The single insert row |
| `skills/project-skill-scout/SKILL.md` | The workflow the agent runs at project start |
| `test/core.test.mjs` | 8 local checks; run `node test/core.test.mjs` |

## Design decisions to preserve

- **Candidates come from the live merged catalog** via
  `ctx.skills.list({ scope: exec.agent, cwd, signal })`, so a candidate is always
  something this agent can actually load. External ecosystem search
  (`npx skills find` / skills.sh) is done **by the agent** with `web_search` and
  fed in through the `extra` argument (a JSON array string). Do not silently
  replace this with a subprocess inside the tool.
- **At least 3 candidates per round** (`minCandidates`, default 3). If fewer are
  available the tool says so in its output instead of inventing any.
- **The user chooses.** The tool never auto-selects; the skill requires
  `ask_user_question` with multi-select.
- **Re-search** = call `discover` again with `exclude`; the plugin also keeps its
  own `excluded` list so a later round never repeats an offered name.
- **Archive layout** (default `%DSH_HOME%\skill-scout`, override with the row's
  `config.archiveRoot`):

  ```
  projects/<slug>/
    state.json      rounds, shown candidates, exclusions, choice
    unused.md       ADDRESSES of skills the user did not choose
    unused.jsonl    same, machine-readable
    used/<name>/    FULL SOURCE COPY of each chosen skill (siblings included)
    used/index.md
  ```

  Only chosen skills get their source copied. Unchosen ones stay addresses.

## Verification the install must reach

1. `cordis_inspect_query` shows the `skill-scout` row present and enabled.
2. The `skill_scout` tool is visible to the agent (it registers globally, so it
   appears to the current agent at its next request).
3. `project-skill-scout` appears in the skill catalog.
4. Run one real round: `skill_scout` `action: "discover"` for a throwaway project
   sentence, expect >= 3 ranked candidates; then `action: "choose"` with one name
   and confirm on disk that `unused.md` exists and `used/<name>/` holds a real
   source copy. Then `action: "status"` returns the same project.
5. Delete the throwaway archive directory afterwards
   (`%DSH_HOME%\skill-scout\projects\<slug>`).

## Known risk and its fix

`index.js` imports `@deepseek-ai/dsh-tools` **without declaring it as a
dependency**. The bundle docs say packages shipped with dsh resolve from the dsh
installation, so a bundle declares no dependency on them; that claim is
documented, but it was not executed against a real bundle during authoring. If
activation fails on that resolution, add:

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.4",
  "@deepseek-ai/dsh-skill": "0.2.0-rc.2",
  "@deepseek-ai/dsh-tools": "0.2.0-rc.2"
}
```

…then reinstall. Note the profile is `autoInstallPeers: false`, so peers are
never fetched; and replacing an installed package requires a **restart** to load
a fresh JavaScript module generation.

## Revert

`plugin_manager` `remove_bundle` with the bundle name. `install_bundle` restores
`profiles/web/package.json` and `pnpm-lock.yaml` itself when an install fails, so
a failed attempt needs no manual cleanup.
