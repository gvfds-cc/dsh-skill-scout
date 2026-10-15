/**
 * Skill Scout — Host plugin for the DeepSeek Harness.
 *
 * Provides one tool, `skill_scout`, that:
 *   1. ranks the skills available to this agent against the project being started
 *      and returns at least `minCandidates` candidates,
 *   2. records the user's choice (and every rejected candidate),
 *   3. supports another round on the same project, excluding what was shown, and
 *   4. keeps a local archive: unused skills as addresses, used skills as a full
 *      source copy.
 *
 * The matching `project-skill-scout` skill carries the workflow the agent runs;
 * this module owns discovery, ranking and the archive.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  archiveUsedSource,
  loadState,
  newState,
  parseSkillFile,
  projectDir,
  rankCandidates,
  saveState,
  writeUnusedIndex,
  writeUsedIndex,
} from './core.js'

export const name = 'skill-scout'
export const inject = ['tools', 'skills']

const ACTIONS = ['discover', 'choose', 'status']
const DEFAULT_MIN_CANDIDATES = 3

/* ------------------------------------------------------------- utilities --- */

function asInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v)).filter((v) => v.length > 0)
}

function requireString(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field} is required for this action`)
  return text
}

function resolveArchiveRoot(config) {
  const configured = typeof config?.archiveRoot === 'string' ? config.archiveRoot.trim() : ''
  if (configured) return path.resolve(configured)
  const home =
    process.env.DSH_HOME ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : path.join(process.cwd(), '.dsh'))
  return path.join(home, 'skill-scout')
}

/** One catalog summary -> the candidate shape this plugin ranks and archives. */
function toCandidate(summary) {
  const resourceDir =
    summary.resourceBase?.kind === 'directory'
      ? summary.resourceBase.path
      : summary.path
        ? path.dirname(summary.path)
        : null
  return {
    name: summary.name,
    description: summary.description ?? '',
    whenToUse: summary.whenToUse ?? '',
    source: summary.source ?? 'runtime',
    provider: summary.provider ?? null,
    instructionPath: summary.path ?? null,
    resourceDir,
    address: summary.path ?? `source: ${summary.source ?? 'runtime'}`,
    external: false,
  }
}

/** Externally found candidates arrive as a JSON string in `extra`. */
function parseExtra(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('extra must be a JSON array of {name, description, source, url}')
  }
  if (!Array.isArray(parsed)) throw new Error('extra must be a JSON array')
  return parsed
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim())
    .map((entry) => ({
      name: entry.name.trim(),
      description: String(entry.description ?? ''),
      whenToUse: String(entry.whenToUse ?? ''),
      source: String(entry.source ?? 'external'),
      provider: null,
      instructionPath: null,
      resourceDir: null,
      address: entry.url ?? entry.installCommand ?? entry.address ?? 'external (no address given)',
      external: true,
    }))
}

function catalogLookup(exec) {
  return {
    scope: exec?.agent,
    cwd: exec?.agent?.session?.header?.cwd,
    signal: exec?.signal,
  }
}

/* ---------------------------------------------------- embedded workflow --- */

/**
 * The workflow skill ships as `skills/project-skill-scout/SKILL.md`; reading it
 * from this module's own directory needs no path expression in the profile
 * patch. It registers as an embedded "runtime" skill, so it lands in the
 * registry's global layer and every preset sees it.
 */
function buildSkillRegistration() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.join(here, 'skills', 'project-skill-scout', 'SKILL.md')
  const { front, body } = parseSkillFile(readFileSync(file, 'utf8'))
  return {
    name: front.name ?? 'project-skill-scout',
    description: front.description ?? 'Find the skills a project should use and let the user choose.',
    ...(front.whenToUse ? { whenToUse: front.whenToUse } : {}),
    content: body,
    source: 'runtime',
  }
}

/* -------------------------------------------------------------- renders --- */

function describeCandidate(index, candidate) {
  const bits = [`${index}. ${candidate.name}`]
  if (candidate.score > 0) bits.push(`match ${candidate.score}`)
  if (candidate.matchedKeywords?.length) bits.push(`(${candidate.matchedKeywords.join(', ')})`)
  const lines = [bits.join(' — ')]
  if (candidate.description) lines.push(`   ${candidate.description}`)
  lines.push(`   source: ${candidate.source}${candidate.external ? ' (external)' : ''}`)
  lines.push(`   address: ${candidate.address}`)
  return lines.join('\n')
}

function discoverSummary({ project, state, ranked, catalogSize, archive }) {
  const shown = state.rounds.at(-1)?.shown?.length ?? ranked.length
  const lines = [
    `Skill Scout — round ${state.round} for "${project}"`,
    `Archive: ${archive}`,
    `Candidates: ${ranked.length} shown, ranked from ${catalogSize} local catalog entries` +
      (state.excluded.length ? `; ${state.excluded.length} name(s) excluded as already offered` : ''),
  ]
  if (ranked.length < DEFAULT_MIN_CANDIDATES) {
    lines.push(
      `WARNING: fewer than ${DEFAULT_MIN_CANDIDATES} candidates. Widen the search (web_search plus the find-skills procedure) and call discover again with the "extra" argument.`,
    )
  }
  lines.push('')
  lines.push(ranked.map((c, i) => describeCandidate(i + 1, c)).join('\n\n'))
  lines.push('')
  lines.push(
    'Next: summarize these for the user and let them choose with ask_user_question (multi_select). ' +
      'If they are not satisfied, call this tool again with the same project and "exclude" set to every name above. ' +
      'When they choose, call action "choose" with the exact names they picked.',
  )
  return lines.join('\n')
}

/* ---------------------------------------------------------------- plugin --- */

export function apply(ctx, config = {}) {
  const archiveRoot = resolveArchiveRoot(config)
  const minCandidates = asInt(config?.minCandidates, DEFAULT_MIN_CANDIDATES)

  async function discover(args, exec) {
    const project = requireString(args.project, 'project')
    const keywords = asStringArray(args.keywords)
    const state = (await loadState(archiveRoot, project)) ?? newState(project)
    const excluded = new Set(
      [...(state.excluded ?? []), ...asStringArray(args.exclude)].map((n) => n.toLowerCase()),
    )
    const notExcluded = (candidate) => !excluded.has(String(candidate.name).toLowerCase())

    const summaries = await ctx.skills.list(catalogLookup(exec))
    const local = summaries.map(toCandidate).filter(notExcluded)
    const external = parseExtra(args.extra).filter(notExcluded)
    const pool = [...local, ...external]

    if (pool.length === 0) {
      throw new Error(
        `No skill candidates left for "${project}": ${summaries.length} catalog entries, all excluded. ` +
          'Search outside the catalog (web_search / find-skills) and pass the results as "extra".',
      )
    }

    const ranked = rankCandidates({
      project,
      keywords,
      candidates: pool,
      limit: asInt(args.limit, Math.max(minCandidates, Math.min(pool.length, 5))),
    })

    state.round += 1
    state.rounds.push({
      round: state.round,
      at: new Date().toISOString(),
      keywords,
      shown: ranked.map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source,
        address: c.address,
        instructionPath: c.instructionPath,
        score: c.score,
      })),
      chosen: [],
      outcome: 'pending',
    })
    state.excluded = [...new Set([...(state.excluded ?? []), ...ranked.map((c) => c.name)])]
    await saveState(archiveRoot, project, state)

    return {
      summary: discoverSummary({
        project,
        state,
        ranked,
        catalogSize: summaries.length,
        archive: projectDir(archiveRoot, project),
      }),
      action: 'discover',
      project,
      round: state.round,
      candidates: ranked.map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source,
        address: c.address,
        score: c.score,
      })),
      archive: projectDir(archiveRoot, project),
    }
  }

  async function choose(args, exec) {
    const project = requireString(args.project, 'project')
    const used = asStringArray(args.used)
    if (used.length === 0) throw new Error('used must name at least one chosen skill')
    const state = (await loadState(archiveRoot, project)) ?? newState(project)
    const last = state.rounds.at(-1)

    const byName = new Map(
      (await ctx.skills.list(catalogLookup(exec))).map((summary) => [summary.name, summary]),
    )

    const archived = []
    for (const chosenName of used) {
      const summary = byName.get(chosenName)
      if (summary) {
        const candidate = toCandidate(summary)
        const result = await archiveUsedSource(archiveRoot, project, candidate)
        archived.push({
          name: chosenName,
          source: candidate.source,
          address: candidate.address,
          instructionPath: candidate.instructionPath,
          archivedTo: result.target,
          copied: result.copied,
          note: result.note,
        })
      } else {
        const shown = last?.shown?.find((entry) => entry.name === chosenName)
        archived.push({
          name: chosenName,
          source: shown?.source ?? 'external',
          address: shown?.address ?? null,
          instructionPath: null,
          archivedTo: null,
          copied: false,
          note: 'not installed locally; only its address was recorded',
        })
      }
    }

    state.chosen = [...new Set([...(state.chosen ?? []), ...used])]
    state.used = [...(state.used ?? []).filter((e) => !used.includes(e.name)), ...archived]
    if (last) {
      last.chosen = used
      last.outcome = 'chosen'
    }

    // Everything offered so far that the user did not choose stays an address.
    const chosenSet = new Set(state.chosen)
    const unused = []
    const seen = new Set()
    for (const round of state.rounds) {
      for (const entry of round.shown ?? []) {
        if (chosenSet.has(entry.name) || seen.has(entry.name)) continue
        seen.add(entry.name)
        unused.push({
          round: round.round,
          name: entry.name,
          source: entry.source,
          address: entry.address,
          instructionPath: entry.instructionPath,
          reason: `offered in round ${round.round}, not chosen`,
          recordedAt: new Date().toISOString(),
        })
      }
    }
    state.unused = unused

    const unusedPaths = await writeUnusedIndex(archiveRoot, project, state)
    const usedIndexPath = await writeUsedIndex(archiveRoot, project, state)
    const statePath = await saveState(archiveRoot, project, state)

    const lines = [
      `Skill Scout — recorded the choice for "${project}" (round ${last?.round ?? '-'}).`,
      '',
      `Used (${archived.length}) — source copied when available:`,
      ...archived.map(
        (e) =>
          `  ${e.name}: ${e.copied ? `source -> ${e.archivedTo}` : `NO SOURCE COPIED (${e.note}); address ${e.address}`}`,
      ),
      '',
      `Unused addresses (${unused.length}) -> ${unusedPaths.md}`,
      `Unused machine-readable -> ${unusedPaths.jsonl}`,
      `Used index -> ${usedIndexPath}`,
      `State -> ${statePath}`,
    ]

    return {
      summary: lines.join('\n'),
      action: 'choose',
      project,
      used: archived,
      unusedCount: unused.length,
      archive: projectDir(archiveRoot, project),
      unusedMd: unusedPaths.md,
      unusedJsonl: unusedPaths.jsonl,
      usedIndex: usedIndexPath,
      state: statePath,
    }
  }

  async function status(args) {
    const project = requireString(args.project, 'project')
    const state = await loadState(archiveRoot, project)
    const dir = projectDir(archiveRoot, project)
    if (!state) {
      return {
        summary: `Skill Scout — no record for "${project}" yet. Archive would be ${dir}. Run action "discover" first.`,
        action: 'status',
        project,
        rounds: 0,
        archive: dir,
      }
    }
    const lines = [
      `Skill Scout — "${state.project}"`,
      `Archive: ${dir}`,
      `Rounds: ${state.round}   Chosen: ${state.chosen.length ? state.chosen.join(', ') : '(none)'}`,
      `Excluded (already offered): ${state.excluded.length}`,
      `Unused recorded: ${state.unused.length}   Used archived: ${state.used.length}`,
      '',
      ...state.rounds.map(
        (r) =>
          `  round ${r.round}: ${r.shown.length} shown, outcome ${r.outcome}` +
          (r.chosen.length ? `, chose ${r.chosen.join(', ')}` : ''),
      ),
    ]
    return { summary: lines.join('\n'), action: 'status', project, rounds: state.round, archive: dir }
  }

  const skillScout = defineTool({
      name: 'skill_scout',
      description:
        'Find the skills a project should use, let the user choose, and archive the outcome locally. ' +
        'Actions: "discover" ranks the skills available to this agent against the project and returns at least three candidates ' +
        '(pass externally found ones as a JSON array string in "extra"); ' +
        '"choose" records the names the user picked, copies the source of each used skill into the archive, and keeps every unused candidate as an address; ' +
        '"status" reports the rounds, choice and archive paths for a project. ' +
        'Call "discover" again with "exclude" set to the names already offered when the user is not satisfied.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ACTIONS,
          description: 'discover (find candidates) | choose (record the user\'s pick) | status (read the record).',
        },
        project: {
          type: 'string',
          description:
            'The project sentence or name this selection is for. Required for every action; used to key the local archive.',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra ranking keywords (domain, deliverable, tooling) for discover.',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill names to keep out of this round, so a re-search returns different candidates.',
        },
        used: {
          type: 'array',
          items: { type: 'string' },
          description: 'For choose: the exact skill names the user selected.',
        },
        extra: {
          type: 'string',
          description:
            'For discover: externally found candidates as a JSON array string, [{name, description, source, url}].',
        },
        limit: {
          type: 'integer',
          description: 'How many candidates this round should return (default at least 3).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            summary: { type: 'string' },
            action: { type: 'string' },
            project: { type: 'string' },
            round: { type: 'integer' },
            archive: { type: 'string' },
          },
          required: ['summary'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value.summary ?? '') }],
      },
      async execute(args, exec) {
        const action = String(args.action ?? '')
        if (!ACTIONS.includes(action)) {
          throw new Error(`unknown action "${action}"; expected one of ${ACTIONS.join(', ')}`)
        }
        if (action === 'discover') return discover(args, exec)
        if (action === 'choose') return choose(args, exec)
        return status(args)
      },
  })

  // Both registrations are effects of this plugin's context, so unloading the
  // bundle removes them.
  ctx.effect(() => ctx.tools.register(skillScout))

  ctx.effect(() => {
    try {
      return ctx.skills.register(buildSkillRegistration())
    } catch (error) {
      // The tool stays useful without the workflow skill, so degrade instead of
      // failing the whole row.
      ctx.logger?.warn?.(`skill-scout: workflow skill not registered: ${error?.message ?? error}`)
      return () => {}
    }
  })
}
