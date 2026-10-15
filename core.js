/**
 * Pure helpers for the Skill Scout bundle: keyword ranking, the per-project
 * state store, and the on-disk archive.
 *
 * Nothing in this module imports a Harness package, so it stays usable with
 * plain Node and is safe to unit-test.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/* -------------------------------------------------------------- ranking --- */

const TERM_SPLIT = /[^a-z0-9\u4e00-\u9fa5+#.]+/g

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(TERM_SPLIT)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
}

/**
 * Rank candidates against the project sentence + keywords.
 * Returns at most `limit` entries, best first, each carrying `score` and
 * `matchedKeywords`. When nothing matches, the best available candidates are
 * still returned (score 0) so a round can always offer the configured minimum.
 */
export function rankCandidates({ project, keywords, candidates, limit }) {
  const terms = [...new Set([...tokenize(project), ...(keywords ?? []).flatMap(tokenize)])]
  const scored = (candidates ?? []).map((c) => {
    const name = String(c.name ?? '').toLowerCase()
    const description = String(c.description ?? '').toLowerCase()
    let score = 0
    const matched = []
    for (const term of terms) {
      if (name.includes(term)) {
        score += 3
        matched.push(term)
      } else if (description.includes(term)) {
        score += 1
        matched.push(term)
      }
    }
    return { ...c, score, matchedKeywords: [...new Set(matched)] }
  })
  scored.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
  const want = Math.max(1, Number(limit) || 3)
  return scored.slice(0, want)
}

/* ---------------------------------------------------------------- store --- */

export function slugify(input) {
  const slug = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'project'
}

/** A skill name is used as a directory name, so strip anything path-like. */
export function safeName(name) {
  return String(name ?? 'skill').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.+$/, '') || 'skill'
}

export function projectDir(archiveRoot, project) {
  return path.join(archiveRoot, 'projects', slugify(project))
}

export async function loadState(archiveRoot, project) {
  const file = path.join(projectDir(archiveRoot, project), 'state.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export function newState(project) {
  return {
    project,
    slug: slugify(project),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    round: 0,
    rounds: [],
    chosen: [],
    excluded: [],
    unused: [],
    used: [],
  }
}

export async function saveState(archiveRoot, project, state) {
  const dir = projectDir(archiveRoot, project)
  await mkdir(dir, { recursive: true })
  state.project = project
  state.slug = slugify(project)
  state.updatedAt = new Date().toISOString()
  const file = path.join(dir, 'state.json')
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return file
}

/* -------------------------------------------------------------- archive --- */

function entryAddress(entry) {
  if (entry.address) return entry.address
  if (entry.url) return entry.url
  if (entry.installCommand) return `\`${entry.installCommand}\``
  if (entry.instructionPath) return entry.instructionPath
  return entry.source ? `source: ${entry.source}` : '(unknown)'
}

export async function writeUnusedIndex(archiveRoot, project, state) {
  const dir = projectDir(archiveRoot, project)
  await mkdir(dir, { recursive: true })

  const jsonlPath = path.join(dir, 'unused.jsonl')
  const rows = state.unused.map((e) =>
    JSON.stringify({
      project: state.project,
      round: e.round,
      name: e.name,
      source: e.source ?? null,
      address: entryAddress(e),
      reason: e.reason ?? 'not chosen',
      recordedAt: e.recordedAt ?? null,
    }),
  )
  await writeFile(jsonlPath, rows.length ? `${rows.join('\n')}\n` : '', 'utf8')

  const lines = [
    `# Unused skills — ${state.project}`,
    '',
    'Addresses only. No source is copied for skills the user did not choose.',
    '',
    '| Round | Skill | Source | Address | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...state.unused.map(
      (e) =>
        `| ${e.round ?? '-'} | ${e.name} | ${e.source ?? '-'} | ${entryAddress(e)} | ${e.reason ?? 'not chosen'} |`,
    ),
    '',
  ]
  const mdPath = path.join(dir, 'unused.md')
  await writeFile(mdPath, lines.join('\n'), 'utf8')
  return { jsonl: jsonlPath, md: mdPath }
}

/**
 * Copy the source of one used skill into the archive.
 * `entry.instructionPath` is the skill's SKILL.md (directory bundle) or its
 * flat `<name>.md` file; the copy keeps the whole bundle directory, because a
 * skill may reference sibling scripts and references.
 */
export async function archiveUsedSource(archiveRoot, project, entry) {
  const dir = projectDir(archiveRoot, project)
  const target = path.join(dir, 'used', safeName(entry.name))
  const instructionPath = entry.instructionPath

  if (!instructionPath || !existsSync(instructionPath)) {
    return { target: null, copied: false, note: 'no local source; address recorded only' }
  }

  await mkdir(path.dirname(target), { recursive: true })
  const isBundle = path.basename(instructionPath).toLowerCase() === 'skill.md'
  if (isBundle) {
    await cp(path.dirname(instructionPath), target, { recursive: true, force: true })
  } else {
    await mkdir(target, { recursive: true })
    await cp(instructionPath, path.join(target, path.basename(instructionPath)), { force: true })
  }
  return { target, copied: true, note: null }
}

export async function writeUsedIndex(archiveRoot, project, state) {
  const dir = projectDir(archiveRoot, project)
  await mkdir(dir, { recursive: true })
  const lines = [
    `# Used skills — ${state.project}`,
    '',
    'Each directory below is a full source copy taken when the user chose the skill.',
    '',
    '| Skill | Source | Original location | Archived copy |',
    '| --- | --- | --- | --- |',
    ...state.used.map(
      (e) =>
        `| ${e.name} | ${e.source ?? '-'} | ${e.instructionPath ?? '-'} | ${e.archivedTo ?? '(not copied)'} |`,
    ),
    '',
  ]
  const mdPath = path.join(dir, 'used', 'index.md')
  await writeFile(mdPath, lines.join('\n'), 'utf8')
  return mdPath
}

/* ------------------------------------------------------------- frontmatter --- */

/**
 * Split the `---` frontmatter of a SKILL.md into flat key/value pairs plus the
 * body. Only the flat scalar fields a skill declares are needed here, so this
 * stays a deliberate subset of YAML rather than a second parser dependency.
 */
export function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { front: {}, body: String(text ?? '').trim() }
  const front = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!entry) continue
    let value = entry[2].trim()
    const quoted =
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    front[entry[1]] = value
  }
  return { front, body: text.slice(match[0].length).trim() }
}
