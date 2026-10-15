/**
 * Local checks for the pure half of the bundle. Run with:
 *   node test/core.test.mjs
 * Nothing here touches the Harness: core.js has no Harness imports on purpose.
 */
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  archiveUsedSource,
  loadState,
  newState,
  parseSkillFile,
  projectDir,
  rankCandidates,
  saveState,
  slugify,
  writeUnusedIndex,
  writeUsedIndex,
} from '../core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '.tmp-archive')
const fixture = path.join(here, '.tmp-skill-src', 'office-docx')

let passed = 0
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok   ${label}`)
    })
    .catch((error) => {
      console.error(`FAIL ${label}\n     ${error.message}`)
      process.exitCode = 1
    })
}

await rm(root, { recursive: true, force: true })
await rm(path.join(here, '.tmp-skill-src'), { recursive: true, force: true })

await check('slugify keeps readable slugs', () => {
  assert.equal(slugify('Build a DOCX report!'), 'build-a-docx-report')
  assert.equal(slugify('中文 报告'), '中文-报告')
  assert.equal(slugify('   '), 'project')
})

await check('rankCandidates prefers name matches and always returns the limit', () => {
  const ranked = rankCandidates({
    project: 'write a docx report',
    keywords: ['word'],
    candidates: [
      { name: 'frontend-design', description: 'Web UI design' },
      { name: 'office-docx', description: 'Create Word documents (.docx)' },
      { name: 'office-xlsx', description: 'Excel workbooks' },
      { name: 'find-skills', description: 'Discover skills' },
    ],
    limit: 3,
  })
  assert.equal(ranked.length, 3, 'limit is honoured')
  assert.equal(ranked[0].name, 'office-docx', 'best match ranks first')
  assert.ok(ranked[0].score > 0)
  assert.ok(ranked[0].matchedKeywords.includes('docx'))
})

await check('rankCandidates returns weak candidates rather than nothing', () => {
  const ranked = rankCandidates({
    project: 'zzz',
    candidates: [{ name: 'a' }, { name: 'b' }],
    limit: 3,
  })
  assert.equal(ranked.length, 2, 'never invents candidates')
  assert.equal(ranked[0].score, 0)
})

await check('parseSkillFile splits frontmatter and body', () => {
  const text = ['---', 'name: demo', 'description: A demo skill', 'whenToUse: Whenever', '---', '', '# Body', '', 'text'].join('\n')
  const { front, body } = parseSkillFile(text)
  assert.equal(front.name, 'demo')
  assert.equal(front.description, 'A demo skill')
  assert.equal(front.whenToUse, 'Whenever')
  assert.equal(body, '# Body\n\ntext')
  assert.deepEqual(parseSkillFile('no frontmatter').front, {})
})

await check('state round-trips through the archive', async () => {
  const state = newState('Write a DOCX report')
  state.round = 1
  state.rounds.push({ round: 1, at: 'now', shown: [{ name: 'office-docx', source: 'bundled', address: 'x' }], chosen: [], outcome: 'pending' })
  await saveState(root, state.project, state)
  const loaded = await loadState(root, state.project)
  assert.equal(loaded.project, 'Write a DOCX report')
  assert.equal(loaded.rounds.length, 1)
  assert.ok(existsSync(path.join(projectDir(root, state.project), 'state.json')))
})

await check('unused skills are archived as addresses only', async () => {
  const project = 'Write a DOCX report'
  const state = await loadState(root, project)
  state.unused = [
    {
      round: 1,
      name: 'office-xlsx',
      source: 'bundled',
      address: 'C:\\skills\\office-xlsx\\SKILL.md',
      reason: 'offered in round 1, not chosen',
      recordedAt: 'now',
    },
  ]
  const paths = await writeUnusedIndex(root, project, state)
  const md = await readFile(paths.md, 'utf8')
  const jsonl = await readFile(paths.jsonl, 'utf8')
  assert.match(md, /office-xlsx/)
  assert.match(md, /Addresses only/)
  assert.match(jsonl, /"address":"C:\\\\skills\\\\office-xlsx\\\\SKILL.md"/)
  assert.ok(!existsSync(path.join(projectDir(root, project), 'used', 'office-xlsx')), 'no source copy for unused')
})

await check('used skill source is copied in full', async () => {
  const project = 'Write a DOCX report'
  await mkdir(fixture, { recursive: true })
  await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: office-docx\n---\nbody\n', 'utf8')
  await mkdir(path.join(fixture, 'references'), { recursive: true })
  await writeFile(path.join(fixture, 'references', 'extra.md'), 'reference\n', 'utf8')

  const result = await archiveUsedSource(root, project, {
    name: 'office-docx',
    instructionPath: path.join(fixture, 'SKILL.md'),
  })
  assert.equal(result.copied, true)
  assert.ok(existsSync(path.join(result.target, 'SKILL.md')))
  assert.ok(existsSync(path.join(result.target, 'references', 'extra.md')), 'sibling resources come along')

  const state = await loadState(root, project)
  state.used = [{ name: 'office-docx', source: 'bundled', instructionPath: path.join(fixture, 'SKILL.md'), archivedTo: result.target }]
  const usedIndex = await writeUsedIndex(root, project, state)
  assert.match(await readFile(usedIndex, 'utf8'), /office-docx/)
})

await check('a skill with no local source records its address instead', async () => {
  const result = await archiveUsedSource(root, 'Write a DOCX report', {
    name: 'remote-thing',
    instructionPath: null,
  })
  assert.equal(result.copied, false)
  assert.equal(result.target, null)
  assert.match(result.note, /address recorded only/)
})

await rm(root, { recursive: true, force: true })
await rm(path.join(here, '.tmp-skill-src'), { recursive: true, force: true })

console.log(process.exitCode ? `\n${passed} passed, failures above` : `\nall ${passed} checks passed`)
