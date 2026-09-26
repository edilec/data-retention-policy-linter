import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLI,
  cliRun,
  clean,
  classDocument,
  dataClass,
  duration,
  fixture,
  hold,
  job,
  jobDocument,
  policy,
  policyDocument,
  projectDirectory,
  withRoot,
} from './support.mjs'

/**
 * The command-line surface: the two streams, the three exit codes, and the
 * options.
 *
 * stdout carries the JSON report and nothing else, so a consumer can pipe it
 * straight into a parser. The human summary and every diagnostic go to stderr,
 * which means a non-empty stderr on a successful run is correct rather than a
 * symptom.
 */

test('--help and --version go to stdout and exit 0', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await cliRun([flag])
    assert.equal(result.code, 0, flag)
    assert.equal(result.stdout.startsWith('data-retention-policy-linter'), true, flag)
    assert.equal(result.stdout.includes('DELETES NOTHING'), true, flag)
    assert.equal(result.stderr, '', flag)
  }

  for (const flag of ['-v', '--version']) {
    const result = await cliRun([flag])
    assert.equal(result.code, 0, flag)
    assert.equal(result.stdout.trim(), '0.1.0', flag)
  }
})

test('the help text names every option the binary accepts, and the manifest version matches', async () => {
  const help = (await cliRun(['--help'])).stdout
  const source = await readFile(CLI, 'utf8')
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  const flags = [...source.matchAll(/'(--[a-z-]+)'/g)].map((match) => match[1])
  assert.equal(flags.length > 10, true)
  for (const flag of new Set(flags)) assert.equal(help.includes(flag), true, `--help does not mention ${flag}`)

  assert.equal(help.includes(`0.1.0`), false, 'the version is printed by --version, not by --help')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.bin['data-retention-policy-linter'], './bin/data-retention-policy-linter.mjs')
})

test('stdout carries the report alone, and the human summary is on stderr', async () => {
  const result = await withRoot(clean(), (root) => cliRun(['--root', root]))

  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.tool, 'data-retention-policy-linter')
  assert.equal(report.schemaVersion, '1')
  assert.equal(result.stderr.includes('deletion recommended for 1'), true)
  assert.equal(result.stderr.includes('deletes nothing and schedules nothing'), true)
})

test('--json suppresses the human summary but not the report', async () => {
  const result = await withRoot(clean(), (root) => cliRun(['--root', root, '--json']))

  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})

test('each document can be given a name of its own', async () => {
  const files = {
    'catalog.json': classDocument([dataClass('a.one', 'team-one')]),
    'retention.json': policyDocument([policy('a.one', 'production', duration(1, 'year'))]),
    'matters.json': { schemaVersion: '1', holds: [hold('m', 'released', ['a.one'])] },
    'sweeps.json': jobDocument([job('sweep', ['a.one'])]),
  }

  const result = await withRoot(files, (root) => cliRun([
    '--root', root, '--json',
    '--classes', 'catalog.json',
    '--policies', 'retention.json',
    '--holds', 'matters.json',
    '--jobs', 'sweeps.json',
  ]))

  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout).findings, [])
})

test('a limit flag is parsed, enforced, and refused when it is not a positive integer', async () => {
  const enforced = await withRoot(fixture(
    [dataClass('a.one', 'team-one'), dataClass('b.two', 'team-two')],
    [policy('a.one', 'production', duration(1, 'year')), policy('b.two', 'production', duration(1, 'year'))],
    [],
    [job('sweep', ['a.one', 'b.two'])],
  ), (root) => cliRun(['--root', root, '--json', '--max-classes', '1']))
  assert.equal(enforced.code, 2)
  assert.equal(JSON.parse(enforced.stdout).summary.classes, 0)

  for (const [value, message] of [
    ['0', '--max-classes requires a positive integer'],
    ['many', '--max-classes requires a positive integer'],
    ['1.5', '--max-classes requires a positive integer'],
    // A leading `-` is read as the next flag rather than as a negative number,
    // so this one is refused a step earlier -- which is the same refusal, and
    // the message says which step it was.
    ['-1', '--max-classes requires a value'],
  ]) {
    const result = await withRoot(clean(), (root) => cliRun(['--root', root, '--max-classes', value]))
    assert.equal(result.code, 2, value)
    assert.equal(result.stdout, '', value)
    assert.equal(result.stderr.includes(message), true, value)
  }
})

test('a flag with a missing value, an unknown flag and a repeated flag are all configuration errors', async () => {
  const cases = [
    [['--root'], '--root requires a value'],
    [['--root', '.', '--classes'], '--classes requires a value'],
    [['--root', '.', '--verbose'], 'Unknown option "--verbose"'],
    [['--root', '.', '--root', '.'], '--root was given more than once'],
    [['--root', '.', '--max-classes', '1', '--max-classes', '2'], '--max-classes was given more than once'],
  ]

  for (const [argv, message] of cases) {
    const result = await cliRun(argv)
    assert.equal(result.code, 2, message)
    assert.equal(result.stdout, '', message)
    assert.equal(result.stderr.includes(message), true, `${message} -- got ${result.stderr.slice(0, 120)}`)
  }
})

test('the three exit codes mean what the help says they mean', async () => {
  const passed = await withRoot(clean(), (root) => cliRun(['--root', root, '--json']))
  assert.equal(passed.code, 0)
  assert.equal(JSON.parse(passed.stdout).status, 'pass')

  const failed = await withRoot(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [],
    [job('sweep', [])],
  ), (root) => cliRun(['--root', root, '--json']))
  assert.equal(failed.code, 1)
  assert.equal(JSON.parse(failed.stdout).status, 'fail')

  const unfinished = await withRoot({ ...clean(), 'holds.json': 'nope' }, (root) => cliRun(['--root', root, '--json']))
  assert.equal(unfinished.code, 2)
  assert.equal(JSON.parse(unfinished.stdout).status, 'incomplete')

  const misconfigured = await cliRun(['--root'])
  assert.equal(misconfigured.code, 2)
  assert.equal(misconfigured.stdout, '', 'a run that never had a subject reports nothing about one')
})

test('the human summary prints one line per finding, with its severity, location and rule', async () => {
  const result = await withRoot(fixture(
    [dataClass('a.one', 'team-one')],
    [policy('a.one', 'production', duration(1, 'year'))],
    [hold('matter', 'active', ['a.one'])],
    [job('sweep', ['a.one'])],
  ), (root) => cliRun(['--root', root]))

  const lines = result.stderr.trim().split('\n')
  assert.equal(result.code, 1)
  assert.equal(lines.length, 5, 'three summary lines and two findings')
  assert.equal(lines[3].startsWith('INFO    classes.json/classes/0 hold-active'), true)
  assert.equal(lines[4].startsWith('ERROR   classes.json/classes/0 hold-conflicts-with-job'), true)
})
