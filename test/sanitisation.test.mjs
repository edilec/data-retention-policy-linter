import assert from 'node:assert/strict'
import test from 'node:test'

import { hasForbiddenCharacter } from '../src/index.mjs'
import {
  FORBIDDEN,
  apiReport,
  classDocument,
  cliReport,
  cliRun,
  clean,
  dataClass,
  duration,
  findingsFor,
  fixture,
  hold,
  holdDocument,
  job,
  jobDocument,
  policy,
  policyDocument,
  withRoot,
} from './support.mjs'

/**
 * Sanitisation, checked over the whole report rather than over one field.
 *
 * Four tools in this catalog stripped C0 and the line/paragraph separators and
 * let the C1 range through, and one of them sanitised its evidence carefully
 * and left its identifiers raw -- so a page id holding a newline forged whole
 * lines in the human report. Every case below walks the serialised report and
 * asserts that nothing survived anywhere, and two of them count the lines the
 * human report actually printed.
 */

/**
 * The human report separates its lines with U+000A, which is itself in the C0
 * class, so a whole stream cannot be checked as one string. Each printed line
 * is checked instead -- which is the stronger question anyway: the damage a
 * control character does here is to the line it lands in.
 */
const everyLineIsClean = (stream) => stream.split(String.fromCharCode(10)).every((line) => !hasForbiddenCharacter(line))

test('a forbidden character arriving through an identifier is refused, and none of it reaches the report', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      ...clean(),
      'classes.json': classDocument([
        dataClass('billing.invoices', 'finance-platform'),
        dataClass(`legacy${character}exports`, 'platform'),
      ]),
    })

    assert.equal(findingsFor(report, 'identifier-invalid').length, 1, `${name} must be refused as a class id`)
    assert.equal(findingsFor(report, 'identifier-invalid')[0].location.pointer, '/classes/1/id', name)
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} must not survive anywhere in the report`)
    assert.equal(JSON.stringify(report).includes('legacy'), false, `${name}: a refused value is described, not reproduced`)
  }
})

test('a forbidden character in a hold id, a job id or an environment name is refused the same way', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const cases = [
      ['holds.json', holdDocument([hold(`matter${character}2031`, 'active', ['billing.invoices'])])],
      ['jobs.json', jobDocument([job(`nightly${character}sweep`, ['billing.invoices'])])],
      ['policies.json', policyDocument([policy('billing.invoices', `prod${character}uction`, duration(1, 'year'))])],
      ['holds.json', holdDocument([hold('matter-2031', 'active', [`billing${character}invoices`])])],
    ]

    for (const [file, document] of cases) {
      const report = await apiReport({ ...clean(), [file]: document })
      assert.equal(findingsFor(report, 'identifier-invalid').length, 1, `${name} in ${file}`)
      assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} in ${file}`)
    }
  }
})

test('a forbidden character arriving through an object key is echoed only after it is stripped', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      ...clean(),
      'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance-platform', [`odd${character}key`]: 1 }]),
    })

    const finding = findingsFor(report, 'class-invalid')[0]
    assert.equal(finding.message.includes('unknown key'), true, `${name} arrives through a key`)
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} must not survive anywhere in the report`)
  }
})

test('a forbidden character in an owner or a regulation citation is refused, not cleaned up and used', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      ...clean(),
      'classes.json': classDocument([{ id: 'billing.invoices', owner: `finance${character}platform` }]),
    })

    assert.equal(findingsFor(report, 'class-owner-missing').length, 1, name)
    assert.equal(report.classes[0].owner, null, `${name}: a name that would print differently names nobody`)
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, name)
  }
})

test('a forbidden character arriving through free text reaches evidence only flattened', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      ...clean(),
      'holds.json': holdDocument([hold('matter-2031', 'active', ['billing.invoices'], `served${character}in 2031`)]),
    })

    assert.equal(findingsFor(report, 'hold-active').length, 1, name)
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} must not survive anywhere in the report`)
  }
})

test('a line separator reaching a message cannot forge a line in the human report', async () => {
  const forged = 'ERROR forged.json fake-rule invented'

  // The same input twice, differing only in the character joining the two
  // halves of an unknown key. A space is harmless; each of the four below is a
  // line break to some consumer. If any of them forged a line, the stream would
  // hold one more line than the harmless run does.
  const run = async (character) => {
    const files = {
      ...clean(),
      'classes.json': classDocument([
        dataClass('billing.invoices', 'finance-platform'),
        { id: 'legacy.exports', owner: 'platform', [`odd${character}${forged}`]: 1 },
      ]),
    }
    return withRoot(files, (root) => cliRun(['--root', root]))
  }

  const harmless = await run(' ')
  const harmlessLines = harmless.stderr.split('\n').length
  assert.equal(harmless.stderr.includes(forged), true, 'the key really is echoed, or this proves nothing')
  assert.equal(harmlessLines > 4, true)

  for (const character of [FORBIDDEN['C0 LF'], FORBIDDEN['C1 NEL'], FORBIDDEN['line separator'], FORBIDDEN['paragraph separator']]) {
    const result = await run(character)
    const lines = result.stderr.split('\n')

    assert.equal(lines.at(-1), '', 'the report ends with a newline')
    assert.equal(lines.length, harmlessLines, 'not one line more than the harmless run printed')
    assert.equal(lines.filter((line) => line.startsWith('ERROR forged')).length, 0, 'and nothing was forged')
    assert.equal(everyLineIsClean(result.stderr), true)
  }
})

test('a bidi override cannot reverse what the human report prints', async () => {
  const files = {
    ...clean(),
    'holds.json': holdDocument([hold('matter-2031', 'active', ['billing.invoices'], `${FORBIDDEN['bidi RLO']}served`)]),
  }
  const result = await withRoot(files, (root) => cliRun(['--root', root]))

  assert.equal(everyLineIsClean(result.stderr), true)
  assert.equal(result.stderr.includes('INFO'), true)
})

test('an argument is flattened before it reaches a stream, because argv never passes through a finding', async () => {
  const result = await cliRun([`--unknown${FORBIDDEN['C0 LF']}option`, '--root', '.'])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(everyLineIsClean(result.stderr), true)
  assert.equal(result.stderr.startsWith('Unknown option "--unknown option"'), true)
})

test('a file name carrying a forbidden character is refused as configuration, before any read', async () => {
  const result = await cliRun(['--root', '.', '--holds', `holds${FORBIDDEN['line separator']}.json`])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error never had a subject, so stdout stays empty')
  assert.equal(result.stderr.includes('must not contain a control, separator or bidi character'), true)
  assert.equal(everyLineIsClean(result.stderr), true)
})

test('nothing forbidden survives in a report that raises many different rules at once', async () => {
  const { report } = await cliReport(fixture(
    [
      dataClass(`a${FORBIDDEN['C1 CSI']}one`, 'team'),
      dataClass('b.two', `owner${FORBIDDEN.DEL}name`),
      dataClass('c.three', 'team'),
    ],
    [policy(`d${FORBIDDEN['C0 ESC']}four`, 'production', duration(1, 'year'))],
    [hold('matter-2031', 'active', [`e${FORBIDDEN['bidi isolate']}five`])],
    [job('nightly-sweep', [`f${FORBIDDEN['C0 NUL']}six`])],
  ))

  assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false)
  assert.equal(report.findings.length > 4, true, 'several rules must fire for this case to mean anything')
  assert.equal(report.status, 'incomplete')
})

/**
 * The canary sweep.
 *
 * Published placeholders only -- no real credential appears in this repository.
 * Each one is planted in a field a careless tool would echo, and then *every
 * prefix* of it is searched for across the whole serialised report and both
 * streams. Checking the field somebody remembered is a test the next field
 * passes for free; checking prefixes catches a truncating excerpt that leaks
 * the first half.
 */
const CANARIES = Object.freeze([
  'AKIAIOSFODNN7EXAMPLE',
  '4111111111111111',
  'token.example.invalid',
])

test('a value planted in a description or an owner never reaches either stream, at any prefix', async () => {
  for (const canary of CANARIES) {
    const files = fixture(
      [dataClass('billing.invoices', 'finance-platform', { description: `see ${canary}` })],
      [policy('billing.invoices', 'production', duration(1, 'year'), `keyed on ${canary}`)],
      [hold('matter-2031', 'released', ['billing.invoices'], `filed under ${canary}`)],
      [job('nightly-sweep', ['billing.invoices'], `runs as ${canary}`)],
    )

    const result = await withRoot(files, (root) => cliRun(['--root', root]))
    const streams = `${result.stdout}\n${result.stderr}`

    assert.equal(result.code, 0, canary)
    for (let length = 8; length <= canary.length; length += 1) {
      assert.equal(streams.includes(canary.slice(0, length)), false, `${canary}: the first ${length} characters leaked`)
    }
  }
})

test('a value planted in a field the tool refuses is described rather than quoted, at any prefix', async () => {
  for (const canary of CANARIES) {
    const files = fixture(
      [
        dataClass('billing.invoices', 'finance-platform'),
        { id: `legacy ${canary}`, owner: 'platform' },
        { id: 'archive.exports', owner: `${canary}${FORBIDDEN['C0 LF']}team` },
      ],
      [policy('billing.invoices', 'production', canary)],
      [],
      [job('nightly-sweep', ['billing.invoices'])],
    )

    const result = await withRoot(files, (root) => cliRun(['--root', root]))
    const streams = `${result.stdout}\n${result.stderr}`

    assert.equal(result.code, 2, canary)
    assert.equal(streams.includes('character(s)'), true, `${canary}: the refusals really did describe something`)
    for (let length = 8; length <= canary.length; length += 1) {
      assert.equal(streams.includes(canary.slice(0, length)), false, `${canary}: the first ${length} characters leaked`)
      assert.equal(
        streams.toLowerCase().includes(canary.slice(0, length).toLowerCase()),
        false,
        `${canary}: the first ${length} characters leaked, in some case or other`,
      )
    }
  }
})
