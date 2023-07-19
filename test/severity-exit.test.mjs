import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  apiReport,
  classDocument,
  cliReport,
  cliRun,
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
  scriptedClock,
  withRoot,
} from './support.mjs'

/**
 * Severity, pinned by what the tool does rather than by what it declares.
 *
 * A severity table asserted against a documented catalog is three declarations
 * agreeing with each other, and one coordinated edit of all three leaves every
 * assertion that compares them satisfied: a sibling tool had 40 of its 52 error
 * rules survive exactly that flip. So every case in this file drives a real
 * input through the real entry point and asserts the observable outcome -- the
 * process exit code and the literal error and warning counts.
 *
 * Demote any error rule below to a warning and its case fails, because the
 * error count drops and, for the rules whose runs complete, the exit code moves
 * from 1 to 0. Promote any warning or info rule and its case fails from the
 * other side. Nothing in this file imports the severity table, and every
 * expected value is a literal written where it is asserted.
 *
 * Rules that make a run incomplete exit 2 whatever their severity, so their
 * cases pin the error count instead; an exit code and a count are both outcomes,
 * and neither can be edited into agreement with a table.
 */

const twoClasses = (second) => fixture(
  [dataClass('a.one', 'team-one'), second],
  [policy('a.one', 'production', duration(1, 'year'))],
  [],
  [job('sweep', ['a.one'])],
)

test('a policy set with nothing wrong exits 0 with an empty findings list', async () => {
  const { code, report } = await cliReport(clean())

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.deepEqual(report.findings, [])
})

test('a class with no owner exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [{ id: 'a.one' }],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a retention period below its regulatory minimum exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one', { regulatoryMinimum: duration(8, 'year') })],
    [policy('a.one', 'production', duration(3, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('two environments that provably disagree exit 1', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(2, 'year')), policy('a.one', 'staging', duration(5, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a class no deletion job covers exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', [])],
  ))

  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1, 'the empty job is the warning; the uncovered class is the error')
})

test('a class with no retention policy in any environment exits 1, and so does the job that covers it', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one', 'b.two'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.summary.errors, 2, 'class-unpolicied and job-class-unpolicied')
  assert.equal(report.summary.warnings, 0)
})

test('a job or a hold naming a class the catalog does not declare exits 1', async () => {
  const jobs = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one', 'ghost.class'])],
  ))
  assert.equal(jobs.code, 1)
  assert.equal(jobs.report.summary.errors, 1)
  assert.equal(jobs.report.summary.warnings, 0)

  const holds = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [hold('matter', 'active', ['ghost.class'])],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(holds.code, 1)
  assert.equal(holds.report.summary.errors, 1)
  assert.equal(holds.report.summary.warnings, 0)
})

test('a retention policy written for a class the catalog does not declare exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year')), policy('ghost.class', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a deletion job pointed at a class under an active legal hold exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [hold('matter', 'active', ['a.one'])],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.findings.length, 2, 'the conflict, and the active hold recorded as information')
})

test('a class listed twice by one deletion job exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one', 'a.one'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

/** The runs that complete with only warnings, or only information, exit 0. */

test('a class present in some environments and not others exits 0', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('a.one', 'staging', duration(1, 'year')),
      policy('b.two', 'production', duration(1, 'year')),
    ],
    [],
    [job('sweep', ['a.one', 'b.two'])],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
})

test('a hold that names no class exits 0', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [hold('matter', 'active', [])],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
})

test('a deletion job that names no class exits 0', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one']), job('quarterly', [])],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
})

test('an active legal hold on its own exits 0, because a hold is the system working', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [hold('matter', 'active', ['a.one'])],
    [job('sweep', [])],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1, 'the empty job')
  assert.equal(report.findings.length, 2)
  assert.equal(report.summary.deletionRecommended, 0, 'and still nothing is recommended for deletion')
})

/**
 * The runs that cannot complete. Each exits 2 whatever the severity of the rule
 * that stopped it, so the count is what pins the severity here.
 */

test('a document that is not an object exits 2 with one error', async () => {
  const { code, report } = await cliReport({ ...clean(), 'classes.json': [] })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a document version this build does not implement exits 2 with one error', async () => {
  const { code, report } = await cliReport({ ...clean(), 'policies.json': { schemaVersion: '2', policies: [] } })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('an entry with an unknown key exits 2 with one error, one per document kind', async () => {
  const cases = [
    ['classes.json', classDocument([dataClass('a.one', 'team-one'), { id: 'b.two', owner: 't', retention: 1 }])],
    ['policies.json', policyDocument([{ class: 'a.one', environment: 'production', retention: duration(1, 'year'), cron: '0 3 * * *' }])],
    ['holds.json', holdDocument([{ id: 'matter', status: 'active', classes: [], matter: 'x' }])],
    ['jobs.json', jobDocument([{ id: 'sweep', classes: ['a.one'], cron: '0 3 * * *' }])],
  ]

  const expected = [
    { errors: 1, warnings: 0 },
    { errors: 1, warnings: 0 },
    { errors: 2, warnings: 0 },
    { errors: 2, warnings: 0 },
  ]

  for (let index = 0; index < cases.length; index += 1) {
    const [name, document] = cases[index]
    const { code, report } = await cliReport({
      ...fixture(
        [dataClass('a.one', 'team-one')],
        [policy('a.one', 'production', duration(1, 'year'))],
        [],
        [job('sweep', ['a.one'])],
      ),
      [name]: document,
    })

    assert.equal(code, 2, name)
    assert.equal(report.summary.errors, expected[index].errors, name)
    assert.equal(report.summary.warnings, expected[index].warnings, name)
  }
})

test('an id that is not a name exits 2 with one error', async () => {
  const { code, report } = await cliReport(twoClasses({ id: 4, owner: 'team-two' }))

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a duplicate class id exits 2 with one error', async () => {
  const { code, report } = await cliReport(twoClasses(dataClass('a.one', 'team-two')))

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a duplicate hold id or job id exits 2, and takes the coverage of that document with it', async () => {
  const holds = await cliReport({
    ...clean(),
    'holds.json': holdDocument([hold('matter', 'released', []), hold('matter', 'active', [])]),
  })
  assert.equal(holds.code, 2)
  assert.equal(holds.report.summary.errors, 2, 'the duplicate, and the hold set no longer being known')
  assert.equal(holds.report.summary.warnings, 1, 'the hold that names no class')

  const jobs = await cliReport({
    ...clean(),
    'jobs.json': jobDocument([job('sweep', ['billing.invoices']), job('sweep', ['billing.invoices'])]),
  })
  assert.equal(jobs.code, 2)
  assert.equal(jobs.report.summary.errors, 2)
  assert.equal(jobs.report.summary.warnings, 0)
})

test('two retention policies for one class in one environment exit 2 with one error', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year')), policy('a.one', 'production', duration(2, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a policy entry that names no readable class exits 2 with two errors', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year')), policy(4, 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ))

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2, 'the unusable name, and no class being recommendable on that evidence')
  assert.equal(report.summary.warnings, 0)
})

test('a hold this build cannot read exits 2 with two errors', async () => {
  const { code, report } = await cliReport({
    ...clean(),
    'holds.json': holdDocument([{ id: 'matter', status: 'lifted', classes: ['billing.invoices'] }]),
  })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2, 'the unsupported status, and the hold set no longer being known')
  assert.equal(report.summary.warnings, 0)
})

test('a hold entry that is not an object exits 2 with two errors', async () => {
  const { code, report } = await cliReport({ ...clean(), 'holds.json': holdDocument(['matter']) })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
})

test('a job entry that is not an object exits 2 with two errors', async () => {
  const { code, report } = await cliReport({ ...clean(), 'jobs.json': jobDocument(['sweep']) })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
})

test('each way a duration can fail to read exits 2 with one error', async () => {
  const cases = [
    ['a string', '30d'],
    ['a bare number', 30],
    ['an unknown unit', { value: 30, unit: 'hour' }],
    ['a value that is not an integer', { value: '30', unit: 'day' }],
  ]

  for (const [label, retention] of cases) {
    const { code, report } = await cliReport(fixture(
      [dataClass('a.one', 'team-one')],
      [policy('a.one', 'production', retention)],
      [],
      [job('sweep', ['a.one'])],
    ))

    assert.equal(code, 2, label)
    assert.equal(report.summary.errors, 1, label)
    assert.equal(report.summary.warnings, 0, label)
  }
})

test('a duration value past its limit exits 2 with one error', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(100, 'day'))],
    [],
    [job('sweep', ['a.one'])],
  ), ['--max-duration-value', '99'])

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a comparison with two answers exits 2 with one error, and never with a verdict', async () => {
  const environments = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'month')), policy('a.one', 'staging', duration(30, 'day'))],
    [],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(environments.code, 2)
  assert.equal(environments.report.summary.errors, 1)
  assert.equal(environments.report.summary.warnings, 0)

  const minimum = await cliReport(fixture(
    [dataClass('a.one', 'team-one', { regulatoryMinimum: duration(3, 'month') })],
    [policy('a.one', 'production', duration(90, 'day'))],
    [],
    [job('sweep', ['a.one'])],
  ))
  assert.equal(minimum.code, 2)
  assert.equal(minimum.report.summary.errors, 1)
  assert.equal(minimum.report.summary.warnings, 0)
})

test('an input that could not be read, decoded or parsed exits 2 with one error', async () => {
  const missing = { ...clean() }
  delete missing['jobs.json']
  const unread = await cliReport(missing)
  assert.equal(unread.code, 2)
  assert.equal(unread.report.summary.errors, 1)
  assert.equal(unread.report.summary.warnings, 0)

  const undecoded = await cliReport({ ...clean(), 'holds.json': new Uint8Array([0x7b, 0xff, 0x7d]) })
  assert.equal(undecoded.code, 2)
  assert.equal(undecoded.report.summary.errors, 1)
  assert.equal(undecoded.report.summary.warnings, 0)

  const unparsed = await cliReport({ ...clean(), 'holds.json': 'holds: none' })
  assert.equal(unparsed.code, 2)
  assert.equal(unparsed.report.summary.errors, 1)
  assert.equal(unparsed.report.summary.warnings, 0)
})

test('a document past the byte limit exits 2, with one error for each document past it', async () => {
  const { code, report } = await cliReport(clean(), ['--max-file-bytes', '1'])

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 4)
  assert.equal(report.summary.warnings, 0)
})

test('a document that resolves outside the root exits 2 with one error', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'data-retention-severity-'))
  try {
    await writeFile(join(outside, 'jobs.json'), JSON.stringify({ schemaVersion: '1', jobs: [] }))

    const result = await withRoot(clean(), async (root) => {
      await rm(join(root, 'jobs.json'))
      await symlink(join(outside, 'jobs.json'), join(root, 'jobs.json'))
      return cliRun(['--root', root, '--json'])
    })
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('each document entry limit exits 2 with one error', async () => {
  const files = fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [hold('m.one', 'released', []), hold('m.two', 'released', [])],
    [job('j.one', ['a.one']), job('j.two', ['b.two'])],
  )

  for (const flag of ['--max-classes', '--max-policies', '--max-holds', '--max-jobs']) {
    const { code, report } = await cliReport(files, [flag, '1'])
    assert.equal(code, 2, flag)
    assert.equal(report.summary.errors, 1, flag)
    assert.equal(report.summary.warnings, 0, flag)
  }
})

test('a class list past its limit exits 2 with two errors', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one', 'b.two'])],
  ), ['--max-class-refs', '1'])

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2, 'the refused list, and coverage no longer being known')
  assert.equal(report.summary.warnings, 0)
})

test('more environments than the limit allows exits 2 with one error', async () => {
  const { code, report } = await cliReport(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year')), policy('a.one', 'staging', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one'])],
  ), ['--max-environments', '1'])

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('more findings than the limit allows exits 2, and the truncation is one of the errors', async () => {
  const { code, report } = await cliReport(fixture(
    [{ id: 'a.one' }, { id: 'b.two' }, { id: 'c.three' }],
    [
      policy('a.one', 'production', duration(1, 'year')),
      policy('b.two', 'production', duration(1, 'year')),
      policy('c.three', 'production', duration(1, 'year')),
    ],
    [],
    [job('sweep', ['a.one', 'b.two', 'c.three'])],
  ), ['--max-findings', '2'])

  assert.equal(code, 2)
  assert.equal(report.findings.length, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
})

test('four documents that compile with no class to evaluate exits 2 with one error', async () => {
  const { code, report } = await cliReport(fixture([], [], [], []))

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
})

test('a run that passes its time budget reports one error, and no recommendation survives it', async () => {
  const report = await apiReport(clean(), {
    limits: { maxRuntimeMs: 1 },
    clock: scriptedClock((call) => (call === 1 ? 0 : 1000)),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.deletionRecommended, 0)
})

test('a configuration error exits 2 with an empty stdout', async () => {
  const missing = await cliRun([])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr.includes('--root is required'), true)

  const unknown = await withRoot(clean(), (root) => cliRun(['--root', root, '--max-class', '3']))
  assert.equal(unknown.code, 2)
  assert.equal(unknown.stdout, '')

  const repeated = await withRoot(clean(), (root) => cliRun(['--root', root, '--holds', 'a.json', '--holds', 'b.json']))
  assert.equal(repeated.code, 2)
  assert.equal(repeated.stdout, '')
  assert.equal(repeated.stderr.includes('--holds was given more than once'), true)
})
