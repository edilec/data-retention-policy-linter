import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, validateLimits } from '../src/index.mjs'
import {
  apiReport,
  clean,
  dataClass,
  duration,
  findingsFor,
  fixture,
  hold,
  job,
  policy,
  scriptedClock,
} from './support.mjs'

/**
 * Every documented limit, enforced and tested from both sides of the bound.
 *
 * A limit that is documented and never wired is the same defect as a limit that
 * is ignored: a sibling tool in this catalog accepted a configuration key and
 * silently did nothing with it. Each case below therefore runs the input that
 * sits exactly on the bound as well as the one past it, and asserts that
 * nothing was read from the document that went past -- a prefix reported as the
 * whole is worse than a refusal.
 */

test('an unknown limit key throws rather than being ignored', async () => {
  assert.throws(() => validateLimits({ maxClass: 10 }), /Unknown limit "maxClass"/)
  assert.throws(() => validateLimits({ maxClass: 10 }), /known limits are maxClassRefs, maxClasses/)
  await assert.rejects(() => apiReport(clean(), { limits: { maxclasses: 10 } }), /Unknown limit "maxclasses"/)
})

test('an unknown option key throws rather than being ignored', async () => {
  await assert.rejects(() => apiReport(clean(), { schedules: 'schedules.json' }), /Unknown option "schedules"/)
  await assert.rejects(() => apiReport(clean(), { clock: 7 }), /clock must be a function/)
})

test('a limit override is an integer inside the hard cap', () => {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    assert.deepEqual(validateLimits({ [key]: 1 })[key], 1)
    assert.deepEqual(validateLimits({ [key]: HARD_LIMITS[key] })[key], HARD_LIMITS[key])
    assert.throws(() => validateLimits({ [key]: 0 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: HARD_LIMITS[key] + 1 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: 1.5 }), new RegExp(`limits.${key} must be an integer`))
  }
  assert.throws(() => validateLimits([]), /limits must be an object/)
  assert.equal(Object.keys(DEFAULT_LIMITS).length, 10)
})

test('each document entry limit is enforced from both sides, and nothing is compiled past it', async () => {
  const files = fixture(
    [dataClass('a.one', 'team'), dataClass('b.two', 'team')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [hold('m.one', 'released', []), hold('m.two', 'released', [])],
    [job('j.one', ['a.one']), job('j.two', ['b.two'])],
  )

  const cases = [
    ['maxClasses', 'too-many-classes', 'classes.json', '/classes', 'classes'],
    ['maxPolicies', 'too-many-policies', 'policies.json', '/policies', 'policies'],
    ['maxHolds', 'too-many-holds', 'holds.json', '/holds', 'holds'],
    ['maxJobs', 'too-many-jobs', 'jobs.json', '/jobs', 'jobs'],
  ]

  for (const [key, ruleId, file, pointer, counted] of cases) {
    const inside = await apiReport(files, { limits: { [key]: 2 } })
    assert.deepEqual(findingsFor(inside, ruleId), [], `${key} at the bound`)
    assert.equal(inside.summary[counted], 2, `${key} at the bound`)

    const outside = await apiReport(files, { limits: { [key]: 1 } })
    const finding = findingsFor(outside, ruleId)[0]
    assert.equal(finding.location.file, file, key)
    assert.equal(finding.location.pointer, pointer, key)
    assert.equal(finding.message.includes(`${key} limit of 1`), true, key)
    assert.equal(outside.summary[counted], 0, `${key}: a prefix was not read and reported as the whole`)
    assert.equal(outside.status, 'incomplete', key)
  }
})

test('maxClassRefs refuses the whole hold or job rather than reading it in part', async () => {
  const files = fixture(
    [dataClass('a.one', 'team'), dataClass('b.two', 'team')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [],
    [job('nightly-sweep', ['a.one', 'b.two'])],
  )

  const inside = await apiReport(files, { limits: { maxClassRefs: 2 } })
  assert.deepEqual(findingsFor(inside, 'too-many-class-references'), [])

  const outside = await apiReport(files, { limits: { maxClassRefs: 1 } })
  const finding = findingsFor(outside, 'too-many-class-references')[0]
  assert.equal(finding.location.pointer, '/jobs/0/classes')
  assert.equal(outside.summary.jobs, 0)
  assert.equal(outside.summary.deletionRecommended, 0, 'coverage is unknown, so nothing is recommended')
  assert.equal(outside.status, 'incomplete')
})

test('maxEnvironments refuses the evaluation rather than comparing some environments and ignoring the rest', async () => {
  const files = fixture(
    [dataClass('a.one', 'team')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('a.one', 'warm-standby', duration(1, 'year')),
    ],
    [],
    [job('nightly-sweep', ['a.one'])],
  )

  const inside = await apiReport(files, { limits: { maxEnvironments: 2 } })
  assert.deepEqual(findingsFor(inside, 'too-many-environments'), [])
  assert.equal(inside.summary.environments, 2)

  const outside = await apiReport(files, { limits: { maxEnvironments: 1 } })
  assert.equal(findingsFor(outside, 'too-many-environments')[0].location.pointer, '/policies')
  assert.equal(outside.summary.checked, 0)
  assert.equal(outside.summary.deletionRecommended, 0)
  assert.deepEqual(outside.classes, [])
  assert.equal(outside.status, 'incomplete')
})

test('maxDurationValue refuses a duration rather than clamping it', async () => {
  const files = fixture(
    [dataClass('a.one', 'team')],
    [policy('a.one', 'production', duration(100, 'day'))],
    [],
    [job('nightly-sweep', ['a.one'])],
  )

  const inside = await apiReport(files, { limits: { maxDurationValue: 100 } })
  assert.deepEqual(inside.findings, [])

  const outside = await apiReport(files, { limits: { maxDurationValue: 99 } })
  const finding = findingsFor(outside, 'duration-out-of-range')[0]
  assert.equal(finding.location.pointer, '/policies/0/retention')
  assert.equal(finding.message.includes('maxDurationValue limit of 99'), true)
  assert.equal(outside.summary.policies, 0)
  assert.equal(outside.status, 'incomplete')
})

test('maxFileBytes refuses a document unread', async () => {
  const files = clean()

  const inside = await apiReport(files, { limits: { maxFileBytes: 4096 } })
  assert.deepEqual(inside.findings, [])

  const outside = await apiReport(files, { limits: { maxFileBytes: 1 } })
  assert.equal(findingsFor(outside, 'input-too-large').length, 4, 'all four documents are past a one-byte limit')
  assert.equal(outside.summary.checked, 0)
  assert.equal(outside.status, 'incomplete')
})

test('maxFindings reports the truncation rather than performing it silently', async () => {
  const files = fixture(
    [dataClass('a.one'), dataClass('b.two'), dataClass('c.three')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('b.two', 'production', duration(1, 'year')),
      policy('c.three', 'production', duration(1, 'year')),
    ],
    [],
    [job('nightly-sweep', ['a.one', 'b.two', 'c.three'])],
  )

  const inside = await apiReport(files, { limits: { maxFindings: 3 } })
  assert.equal(inside.findings.length, 3)
  assert.deepEqual(findingsFor(inside, 'too-many-findings'), [])
  assert.equal(inside.status, 'fail')

  const outside = await apiReport(files, { limits: { maxFindings: 2 } })
  assert.equal(outside.findings.length, 2)
  const finding = findingsFor(outside, 'too-many-findings')[0]
  assert.equal(finding.message.includes('maxFindings limit of 2'), true)
  assert.equal(finding.message.includes('2 were not reported'), true)
  assert.equal(outside.status, 'incomplete', 'a partial report is never a verdict')
})

/**
 * The time budget, and the re-check that happens after the evaluation loop has
 * returned.
 *
 * A budget checked only *inside* a loop cannot be trusted to have fired: a tool
 * in this catalog ran out of steps mid-loop, fell through to its success branch
 * and wrote a confident claim about a group it had not finished comparing. So
 * the budget is asked once more after the loop returns, and everything the loop
 * concluded is downgraded when it has been passed.
 *
 * The two cases below aim an over-budget reading at each side of that boundary.
 * The second one is the important one: the loop completes normally, every
 * recommendation is reached, and the reading that trips the budget is the last
 * one there is.
 */
const budgetFixture = () => fixture(
  [dataClass('a.one', 'team'), dataClass('b.held', 'team')],
  [policy('a.one', 'production', duration(1, 'year')), policy('b.held', 'production', duration(1, 'year'))],
  [hold('matter-2031', 'active', ['b.held'])],
  [job('nightly-sweep', ['a.one'])],
)

test('a budget passed inside the loop stops the run and reports it', async () => {
  const report = await apiReport(budgetFixture(), {
    limits: { maxRuntimeMs: 1 },
    clock: scriptedClock((call) => (call === 1 ? 0 : 1000)),
  })

  assert.equal(findingsFor(report, 'time-budget-exceeded').length, 1)
  assert.equal(report.summary.checked, 0, 'the evaluation never returned, so there are no rows')
  assert.equal(report.summary.deletionRecommended, 0)
  assert.equal(report.status, 'incomplete')
})

test('a budget passed only after the loop still downgrades every conclusion the loop reached', async () => {
  // First, learn how many readings a complete run takes. The last of them is
  // the re-check after the evaluation returns.
  const counting = scriptedClock(() => 0)
  const complete = await apiReport(budgetFixture(), { limits: { maxRuntimeMs: 1000 }, clock: counting })
  const total = counting.state.calls

  assert.equal(complete.status, 'pass', 'the same input finishes normally when the budget is not passed')
  assert.equal(complete.summary.deletionRecommended, 1)
  assert.equal(complete.summary.blockedByHold, 1)
  assert.equal(total > 2, true, 'the run really does check the budget more than once')

  // Now make only the final reading over budget.
  const report = await apiReport(budgetFixture(), {
    limits: { maxRuntimeMs: 1 },
    clock: scriptedClock((call) => (call === total ? 1000 : 0)),
  })

  assert.equal(report.summary.checked, 2, 'the loop did complete: the rows are all there')
  assert.equal(findingsFor(report, 'time-budget-exceeded').length, 1)
  assert.equal(report.summary.deletionRecommended, 0, 'and not one of its conclusions survived as a recommendation')
  assert.equal(report.summary.undecided, 1)
  assert.equal(report.summary.blockedByHold, 1, 'an active hold stays named: it is stricter than undecided')
  assert.equal(report.classes.find((row) => row.id === 'a.one').reasons.includes('time-budget-exceeded'), true)
  assert.equal(report.status, 'incomplete')
})
