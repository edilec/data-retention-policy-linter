import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNITS,
  UNIT_DAYS,
  compareDurations,
  compileDuration,
  formatDuration,
  isExact,
  relateDurations,
  sameExpression,
  satisfiesMinimum,
} from '../src/index.mjs'
import { apiReport, classRow, dataClass, duration, findingsFor, fixture, job, policy } from './support.mjs'

/**
 * Durations, compared as explicit units.
 *
 * The two halves of the contract are tested separately: the arithmetic here,
 * and what the linter *emits* when the arithmetic says "ambiguous", because an
 * ambiguous answer that quietly becomes a pass would be the worst outcome this
 * module can produce.
 */

const days = (value) => compileDuration({ value, unit: 'day' }, 100000).duration
const weeks = (value) => compileDuration({ value, unit: 'week' }, 100000).duration
const months = (value) => compileDuration({ value, unit: 'month' }, 100000).duration
const years = (value) => compileDuration({ value, unit: 'year' }, 100000).duration

test('a duration compiles to the closed interval of days it can span', () => {
  assert.deepEqual([days(30).minDays, days(30).maxDays], [30, 30])
  assert.deepEqual([weeks(2).minDays, weeks(2).maxDays], [14, 14])
  assert.deepEqual([months(1).minDays, months(1).maxDays], [28, 31])
  assert.deepEqual([years(1).minDays, years(1).maxDays], [365, 366])
  assert.deepEqual([years(0).minDays, years(0).maxDays], [0, 0])

  assert.deepEqual(UNITS, ['day', 'month', 'week', 'year'])
  assert.deepEqual(UNIT_DAYS.month, [28, 31])
  assert.equal(isExact(days(30)), true)
  assert.equal(isExact(months(1)), false)
  assert.equal(formatDuration(months(6)), '6 month')
})

test('a duration written as a string is refused, not parsed', () => {
  for (const text of ['30d', 'P7Y', '6 months', '', 'PT1H']) {
    const result = compileDuration(text, 100000)
    assert.equal(result.ok, false, text)
    assert.equal(result.reason, 'string', text)
  }
  assert.equal(compileDuration(30, 100000).reason, 'bare-number')
})

test('a duration must be an object with exactly value and unit', () => {
  assert.equal(compileDuration(null, 100000).reason, 'shape')
  assert.equal(compileDuration([30, 'day'], 100000).reason, 'shape')
  assert.equal(compileDuration({ value: 30, unit: 'day', calendar: 'iso' }, 100000).reason, 'stray-keys')
  assert.deepEqual(compileDuration({ value: 30, unit: 'day', calendar: 'iso' }, 100000).detail, ['calendar'])
  assert.equal(compileDuration({ value: 30 }, 100000).reason, 'unit-shape')
  assert.equal(compileDuration({ value: 30, unit: 'hour' }, 100000).reason, 'unit-unsupported')
  assert.equal(compileDuration({ value: 30, unit: 'fortnight' }, 100000).detail, 'fortnight')
  assert.equal(compileDuration({ value: -1, unit: 'day' }, 100000).reason, 'value-shape')
  assert.equal(compileDuration({ value: 1.5, unit: 'day' }, 100000).reason, 'value-shape')
  assert.equal(compileDuration({ value: '30', unit: 'day' }, 100000).reason, 'value-shape')
  assert.equal(compileDuration({ value: 101, unit: 'day' }, 100).reason, 'value-range')
})

test('two durations in fixed units compare exactly', () => {
  assert.equal(compareDurations(days(7), weeks(1)), 'equal')
  assert.equal(compareDurations(days(6), weeks(1)), 'less')
  assert.equal(compareDurations(days(8), weeks(1)), 'greater')
  assert.equal(compareDurations(years(6), years(7)), 'less')
  assert.equal(sameExpression(days(7), days(7)), true)
  assert.equal(sameExpression(days(7), weeks(1)), false)
})

test('a month against a number of days is ambiguous, and stays that way', () => {
  // 1 month spans [28, 31] and 30 days spans [30, 30]: in February the month is
  // shorter and in March it is longer, so neither order is true all year.
  assert.equal(compareDurations(months(1), days(30)), 'ambiguous')
  assert.equal(compareDurations(days(30), months(1)), 'ambiguous')
  assert.equal(compareDurations(months(1), days(27)), 'greater')
  assert.equal(compareDurations(months(1), days(32)), 'less')
  assert.equal(compareDurations(months(12), years(1)), 'ambiguous')
  assert.equal(compareDurations(months(1), months(1)), 'equal', 'the same expression is equal to itself')
})

test('a regulatory minimum is satisfied only when it is satisfied for every calendar', () => {
  assert.equal(satisfiesMinimum(years(8), years(8)), 'satisfied')
  assert.equal(satisfiesMinimum(days(180), days(90)), 'satisfied')
  assert.equal(satisfiesMinimum(days(89), days(90)), 'below')
  assert.equal(satisfiesMinimum(years(6), years(7)), 'below')
  assert.equal(satisfiesMinimum(days(90), months(3)), 'ambiguous')
  assert.equal(satisfiesMinimum(days(94), months(3)), 'satisfied')
  assert.equal(satisfiesMinimum(days(83), months(3)), 'below')
})

test('two environments agree only when they provably agree', () => {
  assert.equal(relateDurations(days(7), weeks(1)), 'equal')
  assert.equal(relateDurations(months(1), months(1)), 'equal')
  assert.equal(relateDurations(years(2), years(5)), 'differs')
  assert.equal(relateDurations(months(1), days(30)), 'ambiguous')
})

test('an ambiguous regulatory comparison is reported and the class is left undecided, never passed', async () => {
  const report = await apiReport(fixture(
    [dataClass('analytics.sessions', 'analytics-platform', { regulatoryMinimum: duration(3, 'month') })],
    [policy('analytics.sessions', 'production', duration(90, 'day'))],
    [],
    [job('nightly-sweep', ['analytics.sessions'])],
  ))

  const finding = findingsFor(report, 'minimum-comparison-ambiguous')[0]
  assert.equal(finding.location.pointer, '/policies/0/retention')
  assert.equal(finding.evidence, 'retention=90 day; minimum=3 month')
  assert.equal(classRow(report, 'analytics.sessions').recommendation, 'undecided')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.deletionRecommended, 0)
})

test('an ambiguous comparison between two environments is reported as ambiguous, not as a conflict', async () => {
  const report = await apiReport(fixture(
    [dataClass('analytics.sessions', 'analytics-platform')],
    [
      policy('analytics.sessions', 'production', duration(6, 'month')),
      policy('analytics.sessions', 'warm-standby', duration(180, 'day')),
    ],
    [],
    [job('nightly-sweep', ['analytics.sessions'])],
  ))

  assert.deepEqual(findingsFor(report, 'environment-duration-conflict'), [])
  const finding = findingsFor(report, 'environment-duration-ambiguous')[0]
  assert.equal(finding.evidence, 'production=6 month; warm-standby=180 day')
  assert.equal(classRow(report, 'analytics.sessions').recommendation, 'undecided')
  assert.equal(report.status, 'incomplete')
})

test('two environments that provably differ are a conflict rather than an ambiguity', async () => {
  const report = await apiReport(fixture(
    [dataClass('identity.contact-details', 'identity-platform')],
    [
      policy('identity.contact-details', 'production', duration(2, 'year')),
      policy('identity.contact-details', 'warm-standby', duration(5, 'year')),
    ],
    [],
    [job('nightly-sweep', ['identity.contact-details'])],
  ))

  assert.deepEqual(findingsFor(report, 'environment-duration-ambiguous'), [])
  assert.equal(findingsFor(report, 'environment-duration-conflict').length, 1)
  assert.equal(classRow(report, 'identity.contact-details').recommendation, 'blocked')
  assert.equal(report.status, 'fail')
})

test('three environments that pairwise hide a conflict behind an interval still produce one', async () => {
  // production is consistent with each of the others and they are not
  // consistent with each other, which is exactly the case a comparison against
  // the first environment alone would miss.
  const report = await apiReport(fixture(
    [dataClass('analytics.sessions', 'analytics-platform')],
    [
      policy('analytics.sessions', 'production', duration(1, 'month')),
      policy('analytics.sessions', 'staging', duration(28, 'day')),
      policy('analytics.sessions', 'warm-standby', duration(31, 'day')),
    ],
    [],
    [job('nightly-sweep', ['analytics.sessions'])],
  ))

  assert.equal(findingsFor(report, 'environment-duration-conflict').length, 1)
  assert.equal(findingsFor(report, 'environment-duration-conflict')[0].evidence, 'staging=28 day; warm-standby=31 day')
  assert.equal(findingsFor(report, 'environment-duration-ambiguous').length, 1)
  assert.equal(report.status, 'incomplete')
})

test('a retention period of zero is a legitimate policy and is compared like any other', async () => {
  const report = await apiReport(fixture(
    [dataClass('cache.sessions', 'platform', { regulatoryMinimum: duration(1, 'day') })],
    [policy('cache.sessions', 'production', duration(0, 'day'))],
    [],
    [job('nightly-sweep', ['cache.sessions'])],
  ))

  assert.equal(findingsFor(report, 'retention-below-minimum').length, 1)
  assert.equal(classRow(report, 'cache.sessions').recommendation, 'blocked')
})
