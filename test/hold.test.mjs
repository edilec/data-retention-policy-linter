import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  classRow,
  cliReport,
  clean,
  dataClass,
  duration,
  findingsFor,
  fixture,
  hold,
  job,
  policy,
} from './support.mjs'

/**
 * The acceptance property of this tool, pinned from several directions.
 *
 * > An active legal hold outranks every retention rule. A class under an active
 * > hold is never recommended for deletion, whatever its duration says.
 *
 * The cases below vary everything that might tempt a linter into the other
 * answer -- a retention period long past its regulatory minimum, a deletion job
 * already covering the class, a second hold that has been released, a policy
 * set that is otherwise perfect -- and assert the same thing each time. The
 * last case sweeps a matrix of those variations and asserts the property over
 * every row rather than over the one the author was thinking about.
 *
 * Nothing here imports the rule table or the reason vocabulary: every expected
 * value is a literal written where it is asserted.
 */

/** One class, held, and otherwise beyond reproach. */
const heldFixture = (holdStatus, extra = {}) => fixture(
  [dataClass('support.transcripts', 'support-operations', {
    regulation: 'internal-quality-policy-4',
    regulatoryMinimum: duration(90, 'day'),
    ...extra,
  })],
  [policy('support.transcripts', 'production', duration(3650, 'day'))],
  [hold('matter-2031', holdStatus, ['support.transcripts'])],
  [job('nightly-sweep', ['support.transcripts'])],
)

test('a class under an active hold is not recommended for deletion, though its retention is ten times its minimum', async () => {
  const report = await apiReport(heldFixture('active'))
  const row = classRow(report, 'support.transcripts')

  assert.equal(row.recommendation, 'blocked-by-hold')
  assert.deepEqual(row.activeHolds, ['matter-2031'])
  assert.deepEqual(row.retention, [{ environment: 'production', value: 3650, unit: 'day' }])
  assert.equal(report.summary.deletionRecommended, 0)
  assert.equal(report.summary.blockedByHold, 1)
})

test('the same class with the hold released is recommended, which is what makes the case above a case', async () => {
  const report = await apiReport(heldFixture('released'))
  const row = classRow(report, 'support.transcripts')

  assert.equal(row.recommendation, 'eligible')
  assert.deepEqual(row.activeHolds, [])
  assert.deepEqual(row.holds, ['matter-2031'])
  assert.equal(report.summary.deletionRecommended, 1)
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a deletion job pointed at a held class is reported as a conflict to suspend, and the binary exits 1', async () => {
  const { code, report } = await cliReport(heldFixture('active'))
  const conflict = findingsFor(report, 'hold-conflicts-with-job')[0]

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(conflict.severity, 'error')
  assert.equal(conflict.evidence, 'holds: matter-2031; jobs: nightly-sweep')
  assert.equal(conflict.message.includes('suspended'), true)
  assert.equal(classRow(report, 'support.transcripts').recommendation, 'blocked-by-hold')
  assert.equal(report.summary.deletionRecommended, 0)
})

test('a held class with no deletion job is not reported as uncovered, because that would be advice to build one', async () => {
  const report = await apiReport(fixture(
    [dataClass('support.transcripts', 'support-operations')],
    [policy('support.transcripts', 'production', duration(180, 'day'))],
    [hold('matter-2031', 'active', ['support.transcripts'])],
    [job('nightly-sweep', [])],
  ))

  assert.deepEqual(findingsFor(report, 'class-uncovered-by-job'), [])
  assert.equal(findingsFor(report, 'hold-active').length, 1)
  assert.equal(classRow(report, 'support.transcripts').recommendation, 'blocked-by-hold')
  assert.equal(report.summary.deletionRecommended, 0)
})

test('the same class with no hold at all is reported as uncovered, which is what makes the suppression above visible', async () => {
  const report = await apiReport(fixture(
    [dataClass('support.transcripts', 'support-operations')],
    [policy('support.transcripts', 'production', duration(180, 'day'))],
    [],
    [job('nightly-sweep', [])],
  ))

  assert.equal(findingsFor(report, 'class-uncovered-by-job').length, 1)
  assert.equal(classRow(report, 'support.transcripts').recommendation, 'blocked')
})

test('one active hold blocks only the classes it names', async () => {
  const report = await apiReport(fixture(
    [dataClass('a.held', 'team-one'), dataClass('b.free', 'team-two')],
    [policy('a.held', 'production', duration(1, 'year')), policy('b.free', 'production', duration(1, 'year'))],
    [hold('matter-2031', 'active', ['a.held'])],
    [job('nightly-sweep', ['b.free'])],
  ))

  assert.equal(classRow(report, 'a.held').recommendation, 'blocked-by-hold')
  assert.equal(classRow(report, 'b.free').recommendation, 'eligible')
  assert.equal(report.summary.deletionRecommended, 1)
  assert.equal(report.summary.blockedByHold, 1)
})

/**
 * Hold evidence that could not be read blocks everything, including classes no
 * readable hold mentions.
 *
 * Each case removes the ability to know the hold set in a different way. The
 * class in every one of them is otherwise perfect, so the *only* thing keeping
 * it out of `eligible` is the refusal to guess about holds.
 */
test('a holds document that could not be read blocks every deletion recommendation in the run', async () => {
  const cases = [
    ['missing file', { ...clean(), 'holds.json': undefined }],
    ['not JSON', { ...clean(), 'holds.json': 'holds: none' }],
    ['not an object', { ...clean(), 'holds.json': [] }],
    ['wrong version', { ...clean(), 'holds.json': { schemaVersion: '2', holds: [] } }],
  ]

  for (const [label, files] of cases) {
    const prepared = { ...files }
    if (prepared['holds.json'] === undefined) delete prepared['holds.json']
    const { code, report } = await cliReport(prepared)

    assert.equal(code, 2, label)
    assert.equal(report.status, 'incomplete', label)
    assert.equal(report.summary.deletionRecommended, 0, label)
    assert.equal(report.summary.checked, 0, `${label}: an unread document stops the evaluation entirely`)
  }
})

test('a single unreadable hold entry blocks every class, including the ones no readable hold names', async () => {
  const cases = [
    ['a status this build does not implement', hold('matter-2031', 'lifted', ['support.transcripts'])],
    ['a hold that is not an object', 'matter-2031'],
    ['a hold with no usable id', { id: 4, status: 'active', classes: ['support.transcripts'] }],
    ['a hold whose classes is not an array', { id: 'matter-2031', status: 'active', classes: 'support.transcripts' }],
    ['a class name that is not a name', hold('matter-2031', 'active', [{ name: 'support.transcripts' }])],
  ]

  for (const [label, entry] of cases) {
    const report = await apiReport(fixture(
      [dataClass('billing.invoices', 'finance-platform')],
      [policy('billing.invoices', 'production', duration(3, 'year'))],
      [entry],
      [job('nightly-sweep', ['billing.invoices'])],
    ))

    assert.equal(report.status, 'incomplete', label)
    assert.equal(report.summary.deletionRecommended, 0, label)
    assert.equal(report.summary.undecided, 1, label)
    assert.equal(classRow(report, 'billing.invoices').recommendation, 'undecided', label)
    assert.equal(
      classRow(report, 'billing.invoices').reasons.includes('legal-hold-evidence-incomplete'),
      true,
      `${label}: the row says why`,
    )
    assert.equal(findingsFor(report, 'hold-coverage-unknown').length, 1, label)
  }
})

test('the same fixture with a readable hold list is recommended, so the block above is the hold evidence and not the shape', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [hold('matter-2031', 'active', ['support.transcripts'])],
    [job('nightly-sweep', ['billing.invoices'])],
  ))

  // The hold names a class the catalog does not declare, which is an error in
  // its own right -- but it is a *known* error, so every other class keeps its
  // recommendation instead of the whole run going dark.
  assert.equal(findingsFor(report, 'hold-class-unknown').length, 1)
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'eligible')
  assert.equal(report.summary.deletionRecommended, 1)
  assert.equal(report.status, 'fail')
})

/**
 * The sweep.
 *
 * Every combination of the things that could plausibly outvote a hold, driven
 * through the real entry point, with one assertion applied to every row of
 * every report: a row with an active hold is never `eligible` and never counted
 * in `deletionRecommended`.
 */
test('across every variation, no class with an active hold is ever recommended for deletion', async () => {
  const retentions = [duration(0, 'day'), duration(1, 'day'), duration(100000, 'day'), duration(10, 'year')]
  const minimums = [undefined, duration(1, 'day'), duration(99, 'year')]
  const jobLists = [[], ['support.transcripts'], ['support.transcripts', 'billing.invoices']]
  const holdSets = [
    [hold('matter-a', 'active', ['support.transcripts'])],
    [hold('matter-a', 'active', ['support.transcripts']), hold('matter-b', 'released', ['support.transcripts'])],
    [hold('matter-a', 'released', ['support.transcripts']), hold('matter-b', 'active', ['support.transcripts', 'billing.invoices'])],
  ]

  let swept = 0
  let sawHeldRow = 0

  for (const retention of retentions) {
    for (const minimum of minimums) {
      for (const jobClasses of jobLists) {
        for (const holds of holdSets) {
          const extra = minimum === undefined ? {} : { regulatoryMinimum: minimum }
          const report = await apiReport(fixture(
            [
              dataClass('support.transcripts', 'support-operations', extra),
              dataClass('billing.invoices', 'finance-platform'),
            ],
            [
              policy('support.transcripts', 'production', retention),
              policy('billing.invoices', 'production', duration(3, 'year')),
            ],
            holds,
            [job('nightly-sweep', jobClasses)],
          ))

          swept += 1
          const recommended = report.classes.filter((row) => row.recommendation === 'eligible').map((row) => row.id)
          for (const row of report.classes) {
            if (row.activeHolds.length === 0) continue
            sawHeldRow += 1
            assert.equal(row.recommendation, 'blocked-by-hold', `${row.id} is held and must not be recommended`)
            assert.equal(recommended.includes(row.id), false)
          }
          assert.equal(report.summary.deletionRecommended, recommended.length)
        }
      }
    }
  }

  assert.equal(swept, 108, 'the sweep really covered every combination')
  assert.equal(sawHeldRow > 108, true, 'and every report in it really had at least one held row')
})
