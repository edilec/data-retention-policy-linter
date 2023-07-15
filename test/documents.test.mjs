import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASS_DOCUMENT_KEYS,
  CLASS_KEYS,
  DOCUMENT_SCHEMA_VERSION,
  HOLD_KEYS,
  HOLD_STATUSES,
  JOB_KEYS,
  POLICY_KEYS,
} from '../src/index.mjs'
import {
  apiReport,
  classDocument,
  classRow,
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
  raisedRules,
} from './support.mjs'

/**
 * The shape gate.
 *
 * Every case here breaks exactly one thing in an otherwise clean policy set, so
 * the rule under test is the only rule that fires and the assertion cannot be
 * satisfied by some other finding happening to be present.
 */

test('the clean fixture really is clean, or nothing below proves anything', async () => {
  const report = await apiReport(clean())

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('a document must be an object holding its declared list', async () => {
  for (const [name, value] of [
    ['classes.json', []],
    ['policies.json', 7],
    ['holds.json', true],
    ['jobs.json', null],
  ]) {
    const report = await apiReport({ ...clean(), [name]: value })
    assert.equal(findingsFor(report, 'document-invalid').length, 1, name)
    assert.equal(findingsFor(report, 'document-invalid')[0].location.file, name)
    assert.equal(findingsFor(report, 'document-invalid')[0].location.pointer, '', name)
    assert.equal(report.status, 'incomplete', name)
  }
})

test('an unknown document key is refused rather than ignored, so a typo cannot disable a check', async () => {
  const report = await apiReport({
    ...clean(),
    'classes.json': { schemaVersion: DOCUMENT_SCHEMA_VERSION, classes: [], dataClasses: [] },
  })

  const finding = findingsFor(report, 'document-invalid')[0]
  assert.equal(finding.message.includes('"dataClasses"'), true)
  assert.equal(finding.message.includes(CLASS_DOCUMENT_KEYS.join(', ')), true)
  assert.equal(report.status, 'incomplete')
})

test('a document version this build does not implement is refused, not guessed at', async () => {
  for (const version of ['2', 1, undefined, null]) {
    const document = { schemaVersion: version, classes: [] }
    if (version === undefined) delete document.schemaVersion
    const report = await apiReport({ ...clean(), 'classes.json': document })

    assert.equal(findingsFor(report, 'schema-version-unsupported').length, 1, String(version))
    assert.equal(findingsFor(report, 'schema-version-unsupported')[0].location.pointer, '/schemaVersion', String(version))
    assert.equal(report.status, 'incomplete', String(version))
  }
})

test('a list that is not an array is refused', async () => {
  const report = await apiReport({ ...clean(), 'policies.json': { schemaVersion: '1', policies: {} } })

  assert.equal(findingsFor(report, 'document-invalid')[0].location.pointer, '/policies')
  assert.equal(report.status, 'incomplete')
})

test('an entry that is not an object, or carries an unknown key, is refused under its own rule', async () => {
  const cases = [
    ['classes.json', classDocument(['billing.invoices']), 'class-invalid'],
    ['classes.json', classDocument([{ id: 'billing.invoices', owner: 'finance', retention: {} }]), 'class-invalid'],
    ['policies.json', policyDocument(['billing.invoices']), 'policy-invalid'],
    ['policies.json', policyDocument([{ class: 'billing.invoices', environment: 'production', retention: duration(1, 'day'), schedule: '0 3 * * *' }]), 'policy-invalid'],
    ['holds.json', holdDocument([null]), 'hold-invalid'],
    ['holds.json', holdDocument([{ id: 'm', status: 'active', classes: [], matter: 'x' }]), 'hold-invalid'],
    ['jobs.json', jobDocument(['nightly-sweep']), 'job-invalid'],
    ['jobs.json', jobDocument([{ id: 'nightly-sweep', classes: [], cron: '0 3 * * *' }]), 'job-invalid'],
  ]

  for (const [name, document, ruleId] of cases) {
    const report = await apiReport({ ...clean(), [name]: document })
    assert.equal(findingsFor(report, ruleId).length, 1, `${name} ${ruleId}`)
    assert.equal(report.status, 'incomplete', `${name} ${ruleId}`)
  }

  assert.deepEqual(CLASS_KEYS, ['description', 'id', 'owner', 'regulation', 'regulatoryMinimum'])
  assert.deepEqual(POLICY_KEYS, ['class', 'description', 'environment', 'retention'])
  assert.deepEqual(HOLD_KEYS, ['classes', 'description', 'id', 'status'])
  assert.deepEqual(JOB_KEYS, ['classes', 'description', 'id'])
})

test('an id that is not a name is refused, and the value is described rather than reproduced', async () => {
  const report = await apiReport({ ...clean(), 'jobs.json': jobDocument([{ id: 'has space', classes: [] }]) })

  const finding = findingsFor(report, 'identifier-invalid')[0]
  assert.equal(finding.location.pointer, '/jobs/0/id')
  assert.equal(finding.message.includes('a string of 9 character(s)'), true)
  assert.equal(finding.message.includes('has space'), false)
})

test('a duplicate id is refused because neither copy is authoritative', async () => {
  const cases = [
    ['classes.json', classDocument([dataClass('a.one', 'team'), dataClass('a.one', 'other-team')]), 'class-duplicate'],
    ['holds.json', holdDocument([hold('m', 'active', []), hold('m', 'released', [])]), 'hold-duplicate'],
    ['jobs.json', jobDocument([job('n', []), job('n', [])]), 'job-duplicate'],
  ]

  for (const [name, document, ruleId] of cases) {
    const report = await apiReport({ ...clean(), [name]: document })
    assert.equal(findingsFor(report, ruleId).length, 1, ruleId)
    assert.equal(findingsFor(report, ruleId)[0].location.pointer, `/${name.replace('.json', '')}/1/id`, ruleId)
    assert.equal(report.status, 'incomplete', ruleId)
  }
})

test('two policies for one class in one environment are refused, and one environment each is not', async () => {
  const conflicting = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [
      policy('billing.invoices', 'production', duration(3, 'year')),
      policy('billing.invoices', 'production', duration(5, 'year')),
    ],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ))
  assert.equal(findingsFor(conflicting, 'policy-duplicate').length, 1)
  assert.equal(findingsFor(conflicting, 'policy-duplicate')[0].location.pointer, '/policies/1')
  assert.equal(conflicting.status, 'incomplete')
  assert.equal(classRow(conflicting, 'billing.invoices').recommendation, 'undecided')

  const separate = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [
      policy('billing.invoices', 'production', duration(3, 'year')),
      policy('billing.invoices', 'warm-standby', duration(3, 'year')),
    ],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ))
  assert.deepEqual(separate.findings, [])
})

test('a class listed twice by one hold or job is counted once and reported', async () => {
  const report = await apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [],
    [job('nightly-sweep', ['billing.invoices', 'billing.invoices'])],
  ))

  assert.equal(findingsFor(report, 'class-reference-duplicate').length, 1)
  assert.equal(findingsFor(report, 'class-reference-duplicate')[0].location.pointer, '/jobs/0/classes/1')
  assert.deepEqual(classRow(report, 'billing.invoices').deletionJobs, ['nightly-sweep'])
})

test('a legal hold status outside the two this build implements is never read as released', async () => {
  assert.deepEqual(HOLD_STATUSES, ['active', 'released'])

  for (const status of ['lifted', 'ACTIVE', 'pending release', '', true, undefined]) {
    const entry = { id: 'matter-2031', classes: ['billing.invoices'] }
    if (status !== undefined) entry.status = status
    const report = await apiReport({ ...clean(), 'holds.json': holdDocument([entry]) })

    assert.equal(findingsFor(report, 'hold-status-unsupported').length, 1, String(status))
    assert.equal(report.summary.deletionRecommended, 0, `${status}: nothing is recommended on an unreadable hold`)
    assert.equal(report.status, 'incomplete', String(status))
  }
})

test('a description is bounded, and a regulation citation must be usable text', async () => {
  const long = 'd'.repeat(301)

  const described = await apiReport({
    ...clean(),
    'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance-platform', description: long }]),
  })
  assert.equal(findingsFor(described, 'class-invalid')[0].location.pointer, '/classes/0/description')

  const cited = await apiReport({
    ...clean(),
    'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance-platform', regulation: 7 }]),
  })
  assert.equal(findingsFor(cited, 'class-invalid')[0].location.pointer, '/classes/0/regulation')
})

test('a class with no usable owner is still evaluated for everything else', async () => {
  for (const owner of [undefined, '', '   ', 7, null]) {
    const entry = { id: 'billing.invoices' }
    if (owner !== undefined) entry.owner = owner
    const report = await apiReport(fixture(
      [entry],
      [policy('billing.invoices', 'production', duration(3, 'year'))],
      [],
      [job('nightly-sweep', ['billing.invoices'])],
    ))

    assert.deepEqual(raisedRules(report), ['class-owner-missing'], String(owner))
    assert.equal(findingsFor(report, 'class-owner-missing')[0].location.pointer, '/classes/0/owner', String(owner))
    assert.equal(classRow(report, 'billing.invoices').owner, null, String(owner))
    assert.equal(classRow(report, 'billing.invoices').recommendation, 'blocked', String(owner))
    assert.deepEqual(classRow(report, 'billing.invoices').environments, ['production'], String(owner))
  }
})
