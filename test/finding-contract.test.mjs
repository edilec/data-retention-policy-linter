import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT,
  RECOMMENDATIONS,
  RULE_SEVERITY,
  createFinding,
  exitCodeFor,
  hasForbiddenCharacter,
  serializeReport,
} from '../src/index.mjs'
import {
  apiReport,
  classDocument,
  clean,
  dataClass,
  duration,
  fixture,
  hold,
  holdDocument,
  job,
  jobDocument,
  policy,
  policyDocument,
} from './support.mjs'

/**
 * The report envelope, checked against the contract every tool in this catalog
 * implements independently.
 *
 * The corpus below is deliberately wide: the shape assertions are worth more
 * over every rule the tool can raise than over the handful a reviewer thinks of.
 */

const long = 'd'.repeat(400)

const CORPUS = Object.freeze([
  () => apiReport(clean()),
  () => apiReport(fixture([], [], [], [])),
  () => apiReport({ ...clean(), 'classes.json': 'not json' }),
  () => apiReport({ ...clean(), 'holds.json': new Uint8Array([0x7b, 0xff]) }),
  () => apiReport({ ...clean(), 'jobs.json': { schemaVersion: '3', jobs: [] } }),
  () => apiReport({ ...clean(), 'policies.json': [] }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'a.one', owner: 'x', extra: 1 }]) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'a.one' }, { id: 'a.one', owner: 'y' }]) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'a.one', owner: 'x', description: long }]) }),
  () => apiReport({ ...clean(), 'policies.json': policyDocument([policy('billing.invoices', 'production', '1 year')]) }),
  () => apiReport({ ...clean(), 'holds.json': holdDocument([{ id: 'm', status: 'lifted', classes: [] }]) }),
  () => apiReport({ ...clean(), 'jobs.json': jobDocument([job('sweep', ['ghost.class', 'ghost.class'])]) }),
  () => apiReport(fixture(
    [dataClass('a.one', 'team', { regulation: 'Companies Act 2013, s.128', regulatoryMinimum: duration(8, 'year') })],
    [policy('a.one', 'production', duration(3, 'year')), policy('a.one', 'staging', duration(1, 'month'))],
    [hold('m', 'active', ['a.one'])],
    [job('sweep', ['a.one'])],
  )),
  () => apiReport(fixture(
    [dataClass('a.one', 'team', { regulatoryMinimum: duration(3, 'month') }), dataClass('b.two')],
    [policy('a.one', 'production', duration(90, 'day'))],
    [hold('m', 'released', [])],
    [job('sweep', []), job('other', ['a.one'])],
  )),
  () => apiReport(clean(), { limits: { maxFindings: 1, maxClassRefs: 1 } }),
  () => apiReport(fixture(
    [dataClass('a.one', 't1'), dataClass('b.two', 't2'), dataClass('c.three', 't3'), dataClass('d.four', 't4')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('b.two', 'production', duration(1, 'year')),
      policy('c.three', 'production', duration(1, 'year')),
      policy('d.four', 'production', duration(1, 'year')),
    ],
    [hold('m', 'active', ['c.three']), hold('n', 'released', ['a.one'])],
    [job('sweep', ['a.one', 'b.two', 'c.three'])],
  )),
  () => apiReport(fixture(
    [
      dataClass('a.one', 't1', { regulatoryMinimum: duration(1, 'month') }),
      dataClass('b.two', 't2'),
      dataClass('c.three', 't3'),
      dataClass('d.four', 't4'),
    ],
    [
      policy('a.one', 'production', duration(30, 'day')),
      policy('b.two', 'production', duration(1, 'year')),
      policy('b.two', 'warm-standby', duration(2, 'year')),
      policy('c.three', 'warm-standby', duration(1, 'year')),
      policy('d.four', 'production', duration(1, 'year')),
    ],
    [],
    [job('sweep', ['a.one', 'b.two', 'c.three', 'd.four'])],
  )),
])

async function corpus() {
  const reports = []
  for (const build of CORPUS) reports.push(await build())
  return reports
}

test('the envelope carries exactly the documented keys', async () => {
  for (const report of await corpus()) {
    assert.deepEqual(
      Object.keys(report),
      ['schemaVersion', 'tool', 'status', 'summary', 'environments', 'classes', 'findings'],
    )
    assert.equal(report.schemaVersion, '1')
    assert.equal(report.tool, 'data-retention-policy-linter')
    assert.equal(['pass', 'fail', 'incomplete'].includes(report.status), true)
    assert.deepEqual(
      Object.keys(report.summary),
      [
        'checked', 'errors', 'warnings', 'classes', 'policies', 'holds', 'activeHolds', 'jobs',
        'environments', 'deletionRecommended', 'blockedByHold', 'blocked', 'undecided',
      ],
    )
    for (const [key, value] of Object.entries(report.summary)) {
      assert.equal(Number.isInteger(value), true, `summary.${key} is an integer`)
    }

    // Not `value >= 0`: every one of these is a `.length` or a filter count, so
    // non-negativity holds by construction and the assertion cannot fail. What
    // can fail is the summary disagreeing with the report it summarises, which
    // is the thing a consumer reading only the summary would be misled by.
    assert.equal(report.summary.errors, report.findings.filter((row) => row.severity === 'error').length)
    assert.equal(report.summary.warnings, report.findings.filter((row) => row.severity === 'warning').length)
    assert.equal(report.summary.checked, report.classes.length)
    assert.equal(report.summary.environments, report.environments.length)
    assert.equal(
      report.summary.deletionRecommended + report.summary.blockedByHold + report.summary.blocked + report.summary.undecided,
      report.summary.checked,
      'every class checked carries exactly one of the four recommendations',
    )
  }
})

test('every finding carries the documented fields, bounded and sanitised', async () => {
  let seen = 0

  for (const report of await corpus()) {
    for (const finding of report.findings) {
      seen += 1
      const keys = Object.keys(finding)
      assert.equal(keys[0], 'ruleId')
      assert.equal(keys[1], 'severity')
      assert.equal(keys[2], 'message')
      assert.equal(keys[3], 'location')
      for (const key of keys.slice(4)) assert.equal(['evidence', 'suggestion'].includes(key), true, key)

      assert.equal(['error', 'warning', 'info'].includes(finding.severity), true)
      assert.equal(finding.severity, RULE_SEVERITY[finding.ruleId], `${finding.ruleId} takes its severity from the table`)
      assert.match(finding.ruleId, /^[a-z][a-z0-9-]*[a-z0-9]$/)
      assert.equal(typeof finding.message, 'string')
      assert.equal(finding.message.length > 0, true)
      assert.equal(finding.message.length <= 403, true, 'bounded, including the ellipsis')
      assert.deepEqual(Object.keys(finding.location), ['file', 'pointer'])
      assert.equal(finding.location.file.startsWith('/'), false, 'never an absolute host path')
      assert.match(finding.location.pointer, /^(\/[A-Za-z0-9]+)*$/)
      if (finding.evidence !== undefined) assert.equal(finding.evidence.length <= EXCERPT_LIMIT + 3, true)
      if (finding.suggestion !== undefined) assert.equal(finding.suggestion.length <= 303, true)
      assert.equal(hasForbiddenCharacter(JSON.stringify(finding)), false)
    }
  }

  assert.equal(seen > 25, true, 'the corpus really did produce a body of findings')
})

test('every class row carries the documented fields', async () => {
  let seen = 0

  for (const report of await corpus()) {
    for (const row of report.classes) {
      seen += 1
      assert.deepEqual(Object.keys(row), [
        'id', 'owner', 'regulation', 'regulatoryMinimum', 'environments', 'retention',
        'holds', 'activeHolds', 'deletionJobs', 'recommendation', 'reasons',
      ])
      assert.equal(RECOMMENDATIONS.includes(row.recommendation), true)
      assert.equal(row.owner === null || typeof row.owner === 'string', true)
      assert.equal(row.regulatoryMinimum === null || typeof row.regulatoryMinimum.value === 'number', true)
      for (const entry of row.retention) {
        assert.deepEqual(Object.keys(entry), ['environment', 'value', 'unit'])
      }
      assert.deepEqual(row.environments, row.retention.map((entry) => entry.environment))
      for (const id of row.activeHolds) assert.equal(row.holds.includes(id), true, 'an active hold is one of the holds')
      assert.equal(hasForbiddenCharacter(JSON.stringify(row)), false)
    }
  }

  assert.equal(seen > 10, true)
})

test('the status, the exit code and the counts always agree', async () => {
  for (const report of await corpus()) {
    const errors = report.findings.filter((finding) => finding.severity === 'error').length
    const warnings = report.findings.filter((finding) => finding.severity === 'warning').length

    assert.equal(report.summary.errors, errors)
    assert.equal(report.summary.warnings, warnings)
    if (report.status === 'pass') {
      assert.equal(errors, 0, 'a pass never carries an error-severity finding')
      assert.equal(exitCodeFor(report), 0)
      assert.equal(report.summary.checked > 0, true, 'and a pass is never green on no evidence')
    }
    if (report.status === 'fail') assert.equal(exitCodeFor(report), 1)
    if (report.status === 'incomplete') {
      assert.equal(exitCodeFor(report), 2)
      assert.equal(report.summary.deletionRecommended <= report.summary.checked, true)
    }

    const counted = report.summary.deletionRecommended + report.summary.blockedByHold
      + report.summary.blocked + report.summary.undecided
    assert.equal(counted, report.summary.checked, 'every evaluated class is in exactly one bucket')
  }
})

test('no class under an active hold is ever counted as recommended, anywhere in the corpus', async () => {
  let held = 0

  for (const report of await corpus()) {
    for (const row of report.classes) {
      if (row.activeHolds.length === 0) continue
      held += 1
      assert.equal(row.recommendation, 'blocked-by-hold')
    }
  }

  assert.equal(held > 0, true, 'the corpus really does contain a held class')
})

test('the serialised report is stable JSON that a consumer can parse', async () => {
  for (const report of await corpus()) {
    const text = serializeReport(report)
    assert.deepEqual(JSON.parse(text), report)
    assert.equal(text, serializeReport(JSON.parse(text)))
  }
})

test('a finding for a rule outside the table throws rather than being emitted', () => {
  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', file: 'classes.json', pointer: '', message: 'x' }),
    /Rule "invented-rule" is not in RULE_SEVERITY/,
  )
  assert.deepEqual(
    createFinding({ ruleId: 'class-owner-missing', file: 'classes.json', pointer: '/classes/0', message: 'x' }),
    {
      ruleId: 'class-owner-missing',
      severity: 'error',
      message: 'x',
      location: { file: 'classes.json', pointer: '/classes/0' },
    },
  )
})
