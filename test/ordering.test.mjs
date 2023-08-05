import assert from 'node:assert/strict'
import test from 'node:test'

import { lintRetentionPolicies } from '../src/index.mjs'
import {
  apiReport,
  classRow,
  clean,
  cliRun,
  dataClass,
  duration,
  findingsFor,
  fixture,
  hold,
  job,
  policy,
  withRoot,
} from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running. Pinning the comparator itself is no better -- every call site can be
 * swapped on its own, and there are sixteen of them in this package.
 *
 * Every case below chooses inputs an English collator orders the other way
 * round, pushes them through the real report path, and asserts the exact
 * emitted sequence, so that swapping any one site fails a test rather than
 * going unnoticed.
 *
 * Five sites cannot be pinned this way, because their real values -- rule ids,
 * JSON Pointers and this package's reason vocabulary -- collate exactly as they
 * compare. Those are proved equivalent by enumeration in
 * `test/ordering-equivalence.test.mjs` rather than left as gaps.
 *
 * A seventeenth site used to order the unknown keys a message named. Nothing
 * names them any more -- a key is untrusted text and is now counted rather than
 * reproduced -- so the sort was deleted rather than left ordering a list no
 * reader sees.
 */

const collator = new Intl.Collator('en')
const disagrees = (left, right) => {
  assert.equal(left < right, true, `${left} precedes ${right} by code unit`)
  assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is what makes this a case`)
}

test('the disagreements every case below relies on are real', () => {
  disagrees('Z.class', 'a.class')
  disagrees('Z-env', 'a-env')
  disagrees('Z-matter', 'a-matter')
  disagrees('Z-job', 'a-job')
  disagrees('Zextra', 'aextra')
  disagrees('Z.json', 'a.json')
  disagrees('Zmax', 'amax')
})

test('class rows are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [dataClass('Z.class', 'team'), dataClass('a.class', 'team'), dataClass('README.exports', 'team')],
    [
      policy('Z.class', 'production', duration(1, 'year')),
      policy('a.class', 'production', duration(1, 'year')),
      policy('README.exports', 'production', duration(1, 'year')),
    ],
    [],
    [job('sweep', ['Z.class', 'a.class', 'README.exports'])],
  ))

  assert.deepEqual(report.classes.map((row) => row.id), ['README.exports', 'Z.class', 'a.class'])
  assert.notDeepEqual(
    report.classes.map((row) => row.id),
    [...report.classes.map((row) => row.id)].sort((left, right) => collator.compare(left, right)),
    'a collator would order these rows differently',
  )
})

test('the environment list, and each row copy of it, are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [
      policy('billing.invoices', 'Z-env', duration(1, 'year')),
      policy('billing.invoices', 'a-env', duration(1, 'year')),
      policy('billing.invoices', 'README-env', duration(1, 'year')),
    ],
    [],
    [job('sweep', ['billing.invoices'])],
  ))

  assert.deepEqual(report.environments, ['README-env', 'Z-env', 'a-env'])
  assert.deepEqual(classRow(report, 'billing.invoices').environments, ['README-env', 'Z-env', 'a-env'])
  assert.deepEqual(
    classRow(report, 'billing.invoices').retention.map((entry) => entry.environment),
    ['README-env', 'Z-env', 'a-env'],
  )
})

test('which two environments a duration conflict names is decided by code unit', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [
      policy('billing.invoices', 'a-env', duration(9, 'year')),
      policy('billing.invoices', 'Z-env', duration(1, 'year')),
      policy('billing.invoices', 'README-env', duration(5, 'year')),
    ],
    [],
    [job('sweep', ['billing.invoices'])],
  ))

  // Three environments disagree with each other, so which pair is named is
  // whichever pair the scan reaches first -- and the scan follows the sorted
  // order. Under collation the first pair would be a-env against README-env.
  const finding = findingsFor(report, 'environment-duration-conflict')[0]
  assert.equal(finding.evidence, 'README-env=5 year; Z-env=1 year')
  assert.deepEqual(
    classRow(report, 'billing.invoices').retention,
    [
      { environment: 'README-env', value: 5, unit: 'year' },
      { environment: 'Z-env', value: 1, unit: 'year' },
      { environment: 'a-env', value: 9, unit: 'year' },
    ],
  )
})

test('the hold, active-hold and deletion-job lists on a row are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(1, 'year'))],
    [
      hold('a-matter', 'active', ['billing.invoices']),
      hold('Z-matter', 'active', ['billing.invoices']),
      hold('README-matter', 'released', ['billing.invoices']),
    ],
    [
      job('a-job', ['billing.invoices']),
      job('Z-job', ['billing.invoices']),
      job('README-job', ['billing.invoices']),
    ],
  ))

  const row = classRow(report, 'billing.invoices')
  assert.deepEqual(row.holds, ['README-matter', 'Z-matter', 'a-matter'])
  assert.deepEqual(row.activeHolds, ['Z-matter', 'a-matter'])
  assert.deepEqual(row.deletionJobs, ['README-job', 'Z-job', 'a-job'])

  const conflict = findingsFor(report, 'hold-conflicts-with-job')[0]
  assert.equal(conflict.evidence, 'holds: Z-matter, a-matter; jobs: README-job, Z-job, a-job')
})

test('findings are ordered by the file they are about, by code unit', async () => {
  const files = {
    'Z.json': { schemaVersion: '1', classes: [dataClass('billing.invoices', 'finance-platform')] },
    'a.json': { schemaVersion: '1', holds: [{ id: 'matter', status: 'lifted', classes: [] }] },
    'policies.json': { schemaVersion: '1', policies: [policy('billing.invoices', 'production', duration(1, 'year'))] },
    'jobs.json': { schemaVersion: '1', jobs: [job('sweep', ['legacy.clickstream'])] },
  }

  const report = await withRoot(files, (root) =>
    lintRetentionPolicies({ root, classes: 'Z.json', holds: 'a.json' }))

  const seen = report.findings.map((finding) => finding.location.file)
  assert.deepEqual(seen, ['Z.json', 'a.json', 'a.json', 'jobs.json'])
  assert.notDeepEqual(seen, [...seen].sort((left, right) => collator.compare(left, right)))
})

test('which unknown limit or option is named first is decided by code unit', async () => {
  await assert.rejects(
    () => apiReport(clean(), { limits: { amax: 1, Zmax: 1 } }),
    /Unknown limit "Zmax"/,
  )
  await assert.rejects(
    () => apiReport(clean(), { aextra: 1, Zextra: 1 }),
    /Unknown option "Zextra"/,
  )
})

test('the known-limit list printed in that error is ordered by code unit', async () => {
  await assert.rejects(
    () => apiReport(clean(), { limits: { nonsense: 1 } }),
    /maxClassRefs, maxClasses, maxDurationValue, maxEnvironments, maxFileBytes, maxFindings, maxHolds, maxJobs, maxPolicies, maxRuntimeMs/,
  )
})

test('the same inputs produce byte-identical stdout on two runs', async () => {
  const files = fixture(
    [dataClass('Z.class', 'team'), dataClass('a.class', 'team')],
    [
      policy('Z.class', 'Z-env', duration(1, 'year')),
      policy('Z.class', 'a-env', duration(2, 'year')),
      policy('a.class', 'a-env', duration(1, 'year')),
    ],
    [hold('Z-matter', 'active', ['Z.class']), hold('a-matter', 'released', ['a.class'])],
    [job('Z-job', ['Z.class']), job('a-job', ['a.class'])],
  )

  const first = await withRoot(files, (root) => cliRun(['--root', root, '--json']))
  const second = await withRoot(files, (root) => cliRun(['--root', root, '--json']))

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 500, true, 'the report is a real one')
})
