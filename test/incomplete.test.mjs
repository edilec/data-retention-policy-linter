import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  classDocument,
  classRow,
  cliReport,
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
} from './support.mjs'

/**
 * `incomplete`, and the flags that produce it.
 *
 * Deleting a single `state.incomplete = true` in a sibling tool let an entirely
 * unread input report `pass`, with the full suite still green. Each case below
 * therefore asserts the *status* and the *exit code* for one distinct cause, so
 * that removing the flag it depends on turns the case red rather than silently
 * downgrading a refusal into a verdict.
 *
 * The costs of getting this wrong are not symmetrical here. `fail` says "we
 * looked, and this is wrong"; `incomplete` says "we could not finish looking".
 * A tool that recommends deletion has to be able to say the second thing.
 */

/**
 * Assert the status only. Whether a *recommendation* survives an incomplete run
 * depends on what was lost: a refused class entry takes that class out of the
 * report and leaves the others decided, while unreadable hold evidence blocks
 * every class in the run. Each case says which of the two it is.
 */
const expectIncomplete = async (label, files, options) => {
  const report = await apiReport(files, options)
  assert.equal(report.status, 'incomplete', label)
  return report
}

test('an input that could not be reached, read, decoded or parsed is incomplete, never a verdict', async () => {
  const missing = { ...clean() }
  delete missing['policies.json']

  for (const [label, files] of [
    ['a missing document', missing],
    ['bytes that are not UTF-8', { ...clean(), 'classes.json': new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]) }],
    ['text that is not JSON', { ...clean(), 'jobs.json': '{ jobs: [] }' }],
  ]) {
    const report = await expectIncomplete(label, files)
    assert.equal(report.summary.deletionRecommended, 0, `${label}: an unread document stops the evaluation entirely`)
  }
})

test('a document whose shape or version this build cannot take is incomplete', async () => {
  for (const [label, files] of [
    ['not an object', { ...clean(), 'holds.json': 7 }],
    ['an unknown document key', { ...clean(), 'holds.json': { schemaVersion: '1', holds: [], matters: [] } }],
    ['an unimplemented version', { ...clean(), 'jobs.json': { schemaVersion: '2', jobs: [] } }],
    ['a list that is not an array', { ...clean(), 'jobs.json': { schemaVersion: '1', jobs: 'sweep' } }],
  ]) {
    const report = await expectIncomplete(label, files)
    assert.equal(report.summary.deletionRecommended, 0, label)
  }
})

test('an entry that did not compile is incomplete, because the document was read only in part', async () => {
  const report = await expectIncomplete('a refused class entry', fixture(
    [dataClass('a.one', 'team-one'), 'not an object'],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(report.summary.classes, 1, 'one class compiled')
  assert.equal(report.summary.checked, 1, 'and it really was evaluated')
  assert.equal(classRow(report, 'a.one').recommendation, 'eligible', 'the class that did compile keeps its verdict')
  assert.equal(report.status, 'incomplete', 'but the run as a whole is not a pass')
})

test('a class name inside a hold or a job that is not a name is incomplete', async () => {
  const heldRef = await expectIncomplete('a hold reference', {
    ...clean(),
    'holds.json': holdDocument([hold('matter', 'active', ['billing.invoices', 4])]),
  })
  assert.equal(heldRef.summary.deletionRecommended, 0)

  const jobRef = await expectIncomplete('a job reference', {
    ...clean(),
    'jobs.json': jobDocument([job('sweep', ['billing.invoices', 4])]),
  })
  assert.equal(jobRef.summary.deletionRecommended, 0)
})

test('a class this run could not finish deciding about is incomplete', async () => {
  const ambiguous = await expectIncomplete('a duration comparison with two answers', fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'month')), policy('a.one', 'staging', duration(30, 'day'))],
    [],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(ambiguous.summary.undecided, 1)
  assert.equal(classRow(ambiguous, 'a.one').recommendation, 'undecided')

  const minimum = await expectIncomplete('a regulatory comparison with two answers', fixture(
    [dataClass('a.one', 'team-one', { regulatoryMinimum: duration(3, 'month') })],
    [policy('a.one', 'production', duration(90, 'day'))],
    [],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(minimum.summary.undecided, 1)

  const unreadableMinimum = await expectIncomplete('a regulatory minimum that would not read', {
    ...clean(),
    'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance', regulatoryMinimum: '8y' }]),
  })
  assert.equal(unreadableMinimum.summary.undecided, 1)
  assert.equal(unreadableMinimum.summary.checked, 1, 'the class still compiled and was still evaluated')
})

test('an evaluation that never ran is incomplete', async () => {
  const report = await expectIncomplete('more environments than the limit allows', fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year')), policy('a.one', 'staging', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ), { limits: { maxEnvironments: 1 } })

  assert.equal(report.summary.checked, 0)
  assert.deepEqual(report.classes, [])
})

/**
 * The vacuous pass, refused explicitly.
 *
 * Four documents that all compile, with no class left to evaluate, would
 * otherwise report `pass` with `checked: 0`. Both halves of the guard are
 * asserted here -- the finding and the status -- because each is the only thing
 * standing between that input and a green build.
 */
test('four documents that compile with nothing in them is an error and an incomplete run, not a pass', async () => {
  const { code, report } = await cliReport(fixture([], [], [], []))

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(findingsFor(report, 'no-classes-evaluated').length, 1)
  assert.equal(findingsFor(report, 'no-classes-evaluated')[0].severity, 'error')
})

test('the vacuity guard is confined to runs that reached the evaluation, so it backstops nothing', async () => {
  // A run whose class catalog could not be read has already said so under its
  // own rule. If this guard also fired there it would cover for that flag, and
  // removing the flag would change nothing observable.
  const report = await apiReport({ ...clean(), 'classes.json': 'not json' })

  assert.equal(report.summary.checked, 0)
  assert.deepEqual(findingsFor(report, 'no-classes-evaluated'), [])
  assert.equal(findingsFor(report, 'input-not-json').length, 1)
  assert.equal(report.status, 'incomplete')
})

test('a truncated report is incomplete even when every finding it kept is a warning', async () => {
  const report = await apiReport(fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('a.one', 'staging', duration(1, 'year')),
      policy('b.two', 'production', duration(1, 'year')),
    ],
    [hold('matter', 'released', []), hold('other', 'released', [])],
    [job('sweep', ['a.one', 'b.two'])],
  ), { limits: { maxFindings: 2 } })

  assert.equal(report.findings.length, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'too-many-findings').length, 1)
})

test('a run that could not finish is not a pass, and a run that finished badly is not incomplete', async () => {
  // The two statuses are not interchangeable, and this is the pair that shows
  // it: the same class, wrong in a way that can be decided and wrong in a way
  // that cannot.
  const decided = await cliReport(fixture(
    [dataClass('a.one', 'team-one', { regulatoryMinimum: duration(8, 'year') })],
    [policy('a.one', 'production', duration(3, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(decided.code, 1)
  assert.equal(decided.report.status, 'fail')
  assert.equal(classRow(decided.report, 'a.one').recommendation, 'blocked')

  const undecided = await cliReport(fixture(
    [dataClass('a.one', 'team-one', { regulatoryMinimum: duration(3, 'month') })],
    [policy('a.one', 'production', duration(90, 'day'))],
    [],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(undecided.code, 2)
  assert.equal(undecided.report.status, 'incomplete')
  assert.equal(classRow(undecided.report, 'a.one').recommendation, 'undecided')
})

/**
 * The budget passed *after* the loop, on the one input where nothing else can
 * mark the run incomplete.
 *
 * `downgradeRecommendations` leaves a `blocked-by-hold` row alone on purpose,
 * so a run whose only class is under an active hold ends the downgrade with
 * `counts.undecided` still 0 -- and the undecided backstop, which covers every
 * other time-budget case, never fires. Deleting the `state.incomplete = true`
 * in the time-budget branch therefore changed nothing in the suite while
 * changing this run from `incomplete` to `fail`, and the exit code with it.
 *
 * The clock is injected rather than waited on: one run is counted with a clock
 * that never advances, and the second run lets the *last* read -- the re-check
 * after `evaluate` returned -- be the one that is over budget. Tripping the
 * budget any earlier throws out of `evaluate`, leaves `result` null, and is
 * caught by a different flag entirely.
 */
test('a budget passed only after the evaluation returned is incomplete, not merely failed', async () => {
  const files = fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [hold('matter-2031', 'active', ['billing.invoices'])],
    [job('nightly-sweep', ['billing.invoices'])],
  )
  const limits = { maxRuntimeMs: 1000 }

  let reads = 0
  const untimed = await apiReport(files, { limits, clock: () => { reads += 1; return 0 } })
  assert.equal(findingsFor(untimed, 'time-budget-exceeded').length, 0, 'the counting run stayed inside its budget')
  assert.equal(untimed.status, 'fail', 'and it is a fail, so incomplete below cannot come from anything it carried')

  let read = 0
  const report = await apiReport(files, {
    limits,
    clock: () => {
      read += 1
      return read < reads ? 0 : limits.maxRuntimeMs + 1
    },
  })

  assert.equal(findingsFor(report, 'time-budget-exceeded').length, 1, 'the budget fired, after the loop')
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'blocked-by-hold')
  assert.equal(report.summary.undecided, 0, 'nothing was downgraded, so no other flag is doing this work')
  assert.equal(report.status, 'incomplete')
})

test('a policy entry refused without a readable class name leaves every class undecided', async () => {
  const report = await expectIncomplete('an unattributable refusal', fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('b.two', 'production', duration(1, 'year')),
      { environment: 'production', retention: duration(1, 'year') },
    ],
    [],
    [job('sweep', ['a.one', 'b.two'])],
  ))

  assert.equal(report.summary.undecided, 2, 'nobody knows which class the refused policy was for')
  assert.equal(findingsFor(report, 'policy-coverage-unknown').length, 1)
  for (const row of report.classes) assert.equal(row.reasons.includes('policy-evidence-incomplete'), true)
})

test('a policy refused with a readable class name leaves only that class undecided', async () => {
  const report = await expectIncomplete('an attributable refusal', fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('b.two', 'production', '1 year'),
    ],
    [],
    [job('sweep', ['a.one', 'b.two'])],
  ))

  assert.equal(report.summary.undecided, 1)
  assert.equal(report.summary.deletionRecommended, 1, 'the other class is unaffected by a refusal that named a class')
  assert.deepEqual(findingsFor(report, 'policy-coverage-unknown'), [])
  assert.equal(classRow(report, 'b.two').recommendation, 'undecided')
  assert.deepEqual(classRow(report, 'b.two').reasons, ['policy-unreadable'])
  assert.equal(classRow(report, 'a.one').recommendation, 'eligible')
})

test('a class whose only policies were refused is not also reported as having no policy', async () => {
  // "No retention policy declares this class" would be a false statement about
  // a class whose policy was declared and refused, and a false statement is
  // worse than a missing one.
  const report = await expectIncomplete('a refused policy is not an absent one', fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', '1 year')],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.deepEqual(findingsFor(report, 'class-unpolicied'), [])
  assert.deepEqual(findingsFor(report, 'job-class-unpolicied'), [])
  assert.equal(findingsFor(report, 'duration-not-structured').length, 1)
})

test('a job that could not be read completely suppresses every uncovered-class claim', async () => {
  const report = await expectIncomplete('coverage is unknown', fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one', 4])],
  ))

  assert.deepEqual(findingsFor(report, 'class-uncovered-by-job'), [], 'b.two might have been the name that would not read')
  assert.equal(findingsFor(report, 'job-coverage-unknown').length, 1)
  assert.equal(report.summary.undecided, 2)
})

test('the same fixture with a readable job list does report the uncovered class', async () => {
  const report = await cliReport(fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(findingsFor(report.report, 'class-uncovered-by-job').length, 1)
  assert.equal(report.report.status, 'fail')
  assert.equal(report.code, 1)
})

test('an incomplete run still writes a report a consumer can parse, and says so on stderr', async () => {
  const { code, stdout, stderr, report } = await cliReport({ ...clean(), 'holds.json': 'not json' }, [])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(JSON.parse(stdout).status, 'incomplete')
  assert.equal(stderr.includes('incomplete:'), true)
})

test('every document kind refusing an entry is incomplete, one kind at a time', async () => {
  const cases = [
    ['classes.json', classDocument([dataClass('billing.invoices', 'finance-platform'), 4])],
    ['policies.json', policyDocument([policy('billing.invoices', 'production', duration(1, 'year')), 4])],
    ['holds.json', holdDocument([4])],
    ['jobs.json', jobDocument([job('nightly-sweep', ['billing.invoices']), 4])],
  ]

  for (const [name, document] of cases) {
    await expectIncomplete(name, { ...clean(), [name]: document })
  }
})
