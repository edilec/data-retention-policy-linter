import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isInside, lintRetentionPolicies } from '../src/index.mjs'
import { apiReport, classDocument, clean, cliRun, dataClass, findingsFor, withRoot } from './support.mjs'

/**
 * Path confinement, checked from both sides.
 *
 * Rejecting `..` and absolute paths is not confinement: a symbolic link planted
 * inside the declared root points anywhere and contains no `..` at all. The
 * real path of both sides is resolved and compared, which is what the first
 * half of this file checks.
 *
 * The second half checks the failure that hardening of this kind causes on its
 * own: a legitimate file refused. On macOS the system temporary directory is
 * itself reached through a symbolic link, so a root that is not resolved makes
 * every run over a temporary directory refuse every input -- which is why every
 * other test in this suite would go red if that half broke.
 */

test('a declared file name is checked as configuration before any evidence is gathered', async () => {
  for (const [name, pattern] of [
    ['/etc/passwd', /must be relative to --root/],
    ['../outside.json', /must not step outside --root/],
    ['', /must be a relative file name/],
    ['a'.repeat(201), /must be a relative file name/],
  ]) {
    await assert.rejects(() => apiReport(clean(), { classes: name }), pattern, name.slice(0, 20))
  }
  await assert.rejects(() => apiReport(clean(), { root: 7 }), /root must be a non-empty string/)
})

test('a symlink planted inside the root that points out of it is refused unread', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'data-retention-outside-'))
  try {
    await writeFile(join(outside, 'secret.json'), JSON.stringify(classDocument([dataClass('leaked.class', 'nobody')])))

    const report = await withRoot(clean(), async (root) => {
      await rm(join(root, 'classes.json'))
      await symlink(join(outside, 'secret.json'), join(root, 'classes.json'))
      return lintRetentionPolicies({ root })
    })

    assert.equal(findingsFor(report, 'path-escapes-root').length, 1)
    assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, 'classes.json')
    assert.equal(report.status, 'incomplete')
    assert.equal(JSON.stringify(report).includes('leaked.class'), false, 'and nothing out of the tree was echoed')
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a symlink to a directory outside the root is refused as well', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'data-retention-outside-'))
  try {
    await writeFile(join(outside, 'classes.json'), JSON.stringify(classDocument([dataClass('leaked.class', 'nobody')])))

    const report = await withRoot(clean(), async (root) => {
      await symlink(outside, join(root, 'elsewhere'))
      return lintRetentionPolicies({ root, classes: 'elsewhere/classes.json' })
    })

    assert.equal(findingsFor(report, 'path-escapes-root').length, 1)
    assert.equal(JSON.stringify(report).includes('leaked.class'), false)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a dangling symlink is reported as unreadable rather than followed anywhere', async () => {
  const report = await withRoot(clean(), async (root) => {
    await rm(join(root, 'jobs.json'))
    await symlink(join(root, 'never-written.json'), join(root, 'jobs.json'))
    return lintRetentionPolicies({ root })
  })

  assert.equal(findingsFor(report, 'input-unreadable').length, 1)
  assert.equal(findingsFor(report, 'input-unreadable')[0].location.file, 'jobs.json')
  assert.equal(report.status, 'incomplete')
})

test('a symlink inside the root that points inside the root is followed, because refusing it would be a defect too', async () => {
  const report = await withRoot({ ...clean(), 'catalog.json': classDocument([dataClass('billing.invoices', 'finance-platform')]) },
    async (root) => {
      await rm(join(root, 'classes.json'))
      await symlink(join(root, 'catalog.json'), join(root, 'classes.json'))
      return lintRetentionPolicies({ root })
    })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 1)
})

test('a path that leaves the root and comes back is resolved, not refused on its spelling', async () => {
  const report = await withRoot(clean(), async (root) => {
    // `self` is the root reached through a link inside the root. The real path
    // of `self/classes.json` is the root's own `classes.json`, so confinement
    // must accept it: a check that compared spellings would refuse it.
    await symlink(root, join(root, 'self'))
    return lintRetentionPolicies({ root, classes: 'self/classes.json' })
  })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 1)
})

test('a directory named as a document is reported rather than read', async () => {
  const result = await withRoot(clean(), (root) => cliRun(['--root', root, '--classes', '.', '--json']))
  const report = JSON.parse(result.stdout)

  assert.equal(result.code, 2)
  assert.equal(findingsFor(report, 'input-unreadable').length, 1)
  assert.equal(report.status, 'incomplete')
})

test('a root that is not a directory, or does not exist, is a configuration error with an empty stdout', async () => {
  const missing = await cliRun(['--root', join(tmpdir(), 'data-retention-no-such-directory-6f21')])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr.includes('--root could not be resolved'), true)

  const file = await withRoot(clean(), (root) => cliRun(['--root', join(root, 'classes.json')]))
  assert.equal(file.code, 2)
  assert.equal(file.stdout, '')
  assert.equal(file.stderr.includes('--root must be a directory'), true)
})

test('isInside compares resolved paths and does not mistake a sibling for a child', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child.json'), true)
  assert.equal(isInside('/a/root', '/a/rootling/child.json'), false)
  assert.equal(isInside('/a/root', '/a/other'), false)
  assert.equal(isInside('/a/root/', '/a/root/child.json'), true)
})
