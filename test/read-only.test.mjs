import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLI,
  cliRun,
  dataClass,
  duration,
  fixture,
  hold,
  job,
  policy,
  projectDirectory,
  withRoot,
} from './support.mjs'

/**
 * "This tool deletes nothing", proved rather than asserted.
 *
 * The claim is the whole reason a team would be willing to point this at a
 * production retention export, so it is checked three ways, because each of
 * them can hold while the property is false:
 *
 * 1. A byte-for-byte snapshot of the input tree before and after a real run of
 *    the real binary -- names, sizes, contents and modification times. A
 *    deletion, a truncation or a rewrite all move at least one of those.
 * 2. The same over a run that fails and a run that reports incomplete, because
 *    "we only write on success" is a defect this shape of tool is prone to.
 * 3. A read of the shipped source: the only file-system import is a read-only
 *    one, named exactly, so a write verb cannot arrive by another door.
 */

/** Every entry in a directory, with enough of its state to notice any change. */
async function snapshot(root) {
  const names = (await readdir(root)).sort()
  const rows = []
  for (const name of names) {
    const info = await stat(join(root, name))
    const bytes = await readFile(join(root, name))
    rows.push({
      name,
      size: info.size,
      mtimeMs: info.mtimeMs,
      digest: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return rows
}

const held = () => fixture(
  [dataClass('support.transcripts', 'support-operations', { regulatoryMinimum: duration(90, 'day') })],
  [policy('support.transcripts', 'production', duration(180, 'day'))],
  [hold('matter-2031', 'active', ['support.transcripts'])],
  [job('nightly-sweep', ['support.transcripts'])],
)

const conflicting = () => fixture(
  [dataClass('billing.invoices', 'finance-platform', { regulatoryMinimum: duration(8, 'year') })],
  [policy('billing.invoices', 'production', duration(3, 'year'))],
  [],
  [job('nightly-sweep', ['billing.invoices'])],
)

const unreadable = () => ({ ...held(), 'holds.json': 'not json at all' })

test('a real run over a real root changes nothing in it, whatever the verdict', async () => {
  const cases = [
    ['a class blocked by an active hold', held(), 1],
    ['a policy below its regulatory minimum', conflicting(), 1],
    ['an input that could not be parsed', unreadable(), 2],
  ]

  for (const [label, files, expectedCode] of cases) {
    await withRoot(files, async (root) => {
      const before = await snapshot(root)
      const result = await cliRun(['--root', root, '--json'])

      assert.equal(result.code, expectedCode, label)
      const after = await snapshot(root)
      assert.deepEqual(after, before, `${label}: the input tree is byte-for-byte what it was`)
      assert.equal(after.length, 4, `${label}: all four documents are still there`)
    })
  }
})

test('a run that recommends deletion for every class still changes nothing', async () => {
  await withRoot(fixture(
    [dataClass('billing.invoices', 'finance-platform')],
    [policy('billing.invoices', 'production', duration(3, 'year'))],
    [],
    [job('nightly-sweep', ['billing.invoices'])],
  ), async (root) => {
    const before = await snapshot(root)
    const result = await cliRun(['--root', root, '--json'])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 0)
    assert.equal(report.summary.deletionRecommended, 1, 'the run really did recommend a deletion')
    assert.deepEqual(await snapshot(root), before, 'and deleted nothing')
  })
})

test('the shipped examples are unchanged by npm run example, which runs on every check', async () => {
  const root = join(projectDirectory, 'examples/clean')
  const before = await snapshot(root)

  const result = await cliRun(['--root', root, '--json'])
  assert.equal(result.code, 0)

  assert.deepEqual(await snapshot(root), before)
})

async function shippedSource() {
  const parts = []
  for (const directory of ['bin', 'src']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join(String.fromCharCode(10))
}

test('the shipped source imports exactly one file-system surface, and it is read-only', async () => {
  const source = await shippedSource()

  // Naming the bindings that are present is the assertion that means something:
  // a list of verbs that must be absent passes on a prose mention and fails on
  // one, while this line fails the moment a writing verb is imported at all.
  const imports = source.match(/import \{[^}]*\} from 'node:fs[^']*'/g) ?? []
  assert.deepEqual(imports, ["import { readFile, realpath, stat } from 'node:fs/promises'"])
  assert.equal(/from 'node:fs'/.test(source), false, 'no synchronous file-system surface either')
})

test('the shipped source reaches for no way to remove, move or rewrite anything', async () => {
  const source = await shippedSource()

  // Matched as calls rather than as substrings: "truncated" is an honest word
  // in a comment about limits and "truncate" is a way to destroy a file, and a
  // test that cannot tell them apart is a test somebody will delete.
  for (const verb of [
    'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'rename', 'copyFile', 'truncate',
    'createWriteStream', 'opendir', 'chmod', 'chown', 'utimes', 'symlink', 'link',
  ]) {
    assert.equal(new RegExp(`\\b${verb}\\s*\\(`).test(source), false, `the source calls ${verb}()`)
  }
  assert.equal(source.includes('node:child_process'), false, 'nothing could delete on this package behalf')
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bnew\s+Function\b/.test(source), false)
})

test('the binary writes only to the two streams a report contract allows', async () => {
  const source = await readFile(CLI, 'utf8')
  const writes = source.match(/process\.(stdout|stderr)\.write/g) ?? []

  assert.equal(writes.length > 0, true)
  assert.equal(writes.every((call) => call === 'process.stdout.write' || call === 'process.stderr.write'), true)
  assert.equal(source.includes('process.stdin'), false, 'and it reads no stream at all')
})
