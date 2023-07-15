import assert from 'node:assert/strict'
import test from 'node:test'

import { REASONS, RECOMMENDATIONS } from '../src/index.mjs'
import {
  apiReport,
  classRow,
  clean,
  dataClass,
  duration,
  findingsFor,
  fixture,
  hold,
  job,
  policy,
  raisedRules,
} from './support.mjs'

/**
 * The conflicts this tool exists to surface, one case each, each on an
 * otherwise clean policy set so the rule under test is the only rule that
 * fires.
 */

test('a retention period shorter than its regulatory minimum is reported against the policy that is short', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform', {
      regulation: 'Companies Act 2013, s.128',
      regulatoryMinimum: duration(8, 'year'),
    })],
    [
      policy('billing.invoices', 'production', duration(3, 'year')),
      policy('billing.invoices', 'warm-standby', duration(3, 'year')),
    ],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ))

  assert.deepEqual(raisedRules(report), ['retention-below-minimum'])
  assert.equal(findingsFor(report, 'retention-below-minimum').length, 2, 'one per short environment')
  const finding = findingsFor(report, 'retention-below-minimum')[0]
  assert.equal(finding.location.file, 'policies.json')
  assert.equal(finding.location.pointer, '/policies/0/retention')
  assert.equal(finding.evidence, 'retention=3 year; minimum=8 year')
  assert.equal(finding.message.includes('Companies Act 2013, s.128'), true)
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'blocked')
  assert.equal(report.status, 'fail')
})

test('a retention period exactly at its minimum satisfies it', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform', { regulatoryMinimum: duration(8, 'year') })],
    [policy('billing.invoices', 'production', duration(8, 'year'))],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'eligible')
})

test('a deletion job naming a class no catalog declares is reported against the job', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [],
    [job('nightly-sweep', ['billing.invoices', 'legacy.clickstream'])],
  ))

  assert.deepEqual(raisedRules(report), ['job-class-unknown'])
  const finding = findingsFor(report, 'job-class-unknown')[0]
  assert.equal(finding.location.file, 'jobs.json')
  assert.equal(finding.location.pointer, '/jobs/0/classes/1')
  assert.equal(report.status, 'fail')
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'eligible', 'the declared class is unaffected')
})

test('a deletion job naming a declared class that no policy declares is reported separately', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform'), dataClass('legacy.exports', 'platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [],
    [job('nightly-sweep', ['billing.invoices', 'legacy.exports'])],
  ))

  assert.deepEqual(raisedRules(report), ['class-unpolicied', 'job-class-unpolicied'])
  assert.equal(findingsFor(report, 'job-class-unpolicied')[0].location.pointer, '/jobs/0/classes/1')
  assert.equal(findingsFor(report, 'class-unpolicied')[0].location.pointer, '/classes/1')
  assert.equal(classRow(report, 'legacy.exports').recommendation, 'blocked')
  assert.deepEqual(classRow(report, 'legacy.exports').reasons, ['no-retention-policy'])
})

test('a class no deletion job covers is reported against the class', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform'), dataClass('telemetry.page-views', 'analytics')],
    [
      policy('billing.invoices', 'production', duration(3, 'year')),
      policy('telemetry.page-views', 'production', duration(3, 'year')),
    ],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ))

  assert.deepEqual(raisedRules(report), ['class-uncovered-by-job'])
  assert.equal(findingsFor(report, 'class-uncovered-by-job')[0].location.pointer, '/classes/1')
  assert.deepEqual(classRow(report, 'telemetry.page-views').reasons, ['no-deletion-job'])
  assert.equal(report.status, 'fail')
})

test('a retention policy written for a class no catalog declares is reported against the policy', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [
      policy('billing.invoices', 'production', duration(3, 'year')),
      policy('legacy.clickstream', 'production', duration(3, 'year')),
    ],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ))

  assert.deepEqual(raisedRules(report), ['policy-class-unknown'])
  assert.equal(findingsFor(report, 'policy-class-unknown')[0].location.pointer, '/policies/1/class')
  assert.equal(report.classes.length, 1, 'no row is invented for a class nobody declared')
})

test('a class present in some environments and not others is a warning that does not withhold the pass', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform'), dataClass('cache.sessions', 'platform')],
    [
      policy('billing.invoices', 'production', duration(3, 'year')),
      policy('billing.invoices', 'warm-standby', duration(3, 'year')),
      policy('cache.sessions', 'production', duration(1, 'day')),
    ],
    [],
    [job('nightly-sweep', ['billing.invoices', 'cache.sessions'])],
  ))

  assert.deepEqual(raisedRules(report), ['environment-coverage-partial'])
  const finding = findingsFor(report, 'environment-coverage-partial')[0]
  assert.equal(finding.severity, 'warning')
  assert.equal(finding.evidence, 'no policy in: warm-standby')
  assert.equal(report.status, 'pass')
  assert.equal(classRow(report, 'cache.sessions').recommendation, 'eligible')
})

test('a hold or a job that names no class is a warning and blocks nothing', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [hold('matter-2031', 'active', [])],
    [job('nightly-sweep', ['billing.invoices']), job('quarterly-sweep', [])],
  ))

  assert.deepEqual(raisedRules(report), ['hold-covers-nothing', 'job-covers-nothing'])
  assert.equal(report.status, 'pass')
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'eligible')
  assert.equal(report.summary.activeHolds, 1, 'the hold is counted even though it holds nothing here')
})

test('a hold naming a class no catalog declares is an error that leaves other classes decided', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [hold('matter-2031', 'active', ['legacy.clickstream'])],
    [job('nightly-sweep', ['billing.invoices'])],
  ))

  assert.deepEqual(raisedRules(report), ['hold-class-unknown'])
  assert.equal(findingsFor(report, 'hold-class-unknown')[0].location.pointer, '/holds/0/classes/0')
  assert.equal(classRow(report, 'billing.invoices').recommendation, 'eligible')
  assert.equal(report.status, 'fail')
})

test('one class can carry several reasons at once, and they are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', undefined, { regulatoryMinimum: duration(8, 'year') })],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [],
    [job('nightly-sweep', [])],
  ))

  const row = classRow(report, 'billing.invoices')
  assert.deepEqual(row.reasons, ['no-deletion-job', 'owner-missing', 'retention-below-minimum'])
  assert.equal(row.recommendation, 'blocked')
  for (const reason of row.reasons) assert.equal(REASONS.includes(reason), true, reason)
})

test('the row vocabularies are exactly what the documentation says they are', async () => {
  assert.deepEqual(RECOMMENDATIONS, ['blocked', 'blocked-by-hold', 'eligible', 'undecided'])
  assert.equal(REASONS.length, 15)
  assert.deepEqual([...REASONS].sort(), [...REASONS], 'the vocabulary is listed in the order it is emitted in')

  const report = await apiReport(clean())
  for (const row of report.classes) assert.equal(RECOMMENDATIONS.includes(row.recommendation), true)
})

test('every row carries the class its findings are about, and the summary counts add up', async () => {
  const report = await apiReport(fixture(
    [
      dataClass('a.eligible', 'team-one'),
      dataClass('b.blocked', 'team-two'),
      dataClass('c.held', 'team-three'),
      dataClass('d.undecided', 'team-four'),
    ],
    [
      policy('a.eligible', 'production', duration(1, 'year')),
      policy('b.blocked', 'production', duration(1, 'year')),
      policy('c.held', 'production', duration(1, 'year')),
      policy('d.undecided', 'production', duration(1, 'month')),
      policy('d.undecided', 'warm-standby', duration(30, 'day')),
    ],
    [hold('matter-2031', 'active', ['c.held'])],
    [job('nightly-sweep', ['a.eligible', 'd.undecided'])],
  ))

  assert.deepEqual(report.classes.map((row) => row.recommendation), ['eligible', 'blocked', 'blocked-by-hold', 'undecided'])
  assert.equal(report.summary.deletionRecommended, 1)
  assert.equal(report.summary.blocked, 1)
  assert.equal(report.summary.blockedByHold, 1)
  assert.equal(report.summary.undecided, 1)
  assert.equal(report.summary.checked, 4)
  assert.equal(report.status, 'incomplete')
})
