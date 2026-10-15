---
name: project-skill-scout
description: Use before starting a project or a substantial new piece of work to pick the skills that project should use — find matching skills, summarize at least three candidates for the user to choose from, re-search when the user is not satisfied, and archive the outcome locally (addresses of unused skills, source code of used ones).
whenToUse: The user says they are starting a new project, or asks to prepare/set up before work begins, or the project has no recorded skill choice yet.
---

# Project skill scout

Pick the skills this project should use, with the user's explicit choice, and keep a local record of what was considered.

## Workflow

1. **Describe the project in one line.** From the user's request, write a single sentence and derive three to six keywords (domain, deliverable, tooling). Keep them concrete: `python`, `docx`, `report`, `excel`, `plugin`, `frontend`.

2. **Discover candidates.** Call the `skill_scout` tool with `action: "discover"`, your `project` sentence, and `keywords`. It returns the round number, the candidate list ranked against the project, and where the list came from.
   - It returns at least three candidates when the catalog has them. If the tool reports fewer than three, widen the search yourself: use `web_search` and the `find-skills` procedure (`npx skills find <keywords>`, and the leaderboard at https://skills.sh/), then call `discover` again with your findings as the `extra` argument — a JSON string of `[{"name": "...", "description": "...", "source": "...", "url": "..."}]`.

3. **Summarize, then let the user choose.** Present every candidate with `ask_user_question` (`multi_select: true`): name, one line on what it does for this project, and where it comes from (bundled, user-installed, or external URL). Never choose for the user and never start the work before they answer.

4. **Re-search when the user is dissatisfied.** Call `discover` again with `exclude` set to every name already shown in earlier rounds, so the new round returns different candidates. Say which round this is. Repeat until the user picks something, or until the user tells you to proceed without a skill.

5. **Record the decision.** Call `skill_scout` with `action: "choose"`, the `project` string, and `used` set to the exact names the user chose. Every other candidate from that round is archived as unused. The tool writes, under the archive root:
   - `unused.md` and `unused.jsonl` — the **address** of each unused skill: name, source, URL or install command, and why it was not chosen. No source is copied for these.
   - `used/<skill-name>/` — a **full source copy** of every used skill that exists locally.
   - `state.json` — rounds, candidates, exclusions and the final choice.

6. **Load the chosen skills** with the `skill` tool before starting the work, and follow them.

7. **Report the archive location** to the user and state which skills are in effect.

## Rules

- At least three candidates per round whenever the sources can supply them; say so explicitly when they cannot.
- The user chooses. Never auto-select, and never treat silence as approval.
- Copy source only for skills the user actually chose. Everything else stays an address.
- Never re-offer a rejected skill to the same user in a later round unless the user asks for it by name.
- `action: "status"` returns the current state for the project, including rounds so far and the archive paths.
