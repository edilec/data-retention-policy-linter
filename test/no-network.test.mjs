import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  CLI,
  apiReport,
  clean,
  dataClass,
  duration,
  fixture,
  hold,
  job,
  policy,
  projectDirectory,
  withRoot,
} from './support.mjs'

const execFileAsync = promisify(execFile)

/**
 * "No socket is ever opened", proved rather than asserted.
 *
 * Three independent checks, because each of them can be true while the property
 * is false:
 *
 * 1. A module-resolution hook that refuses every network builtin, with the
 *    binary run under it over a real policy set. If any code path reached for a
 *    socket, the import would fail and the run would not produce a report. A
 *    control run proves the hook actually fires, because a guard that never
 *    fires proves nothing.
 * 2. A live loopback listener whose address is planted in the input, which then
 *    records that nothing ever knocked. Input content is data: a URL in a
 *    description is not an instruction to fetch it, and a deletion job named in
 *    a document is not an instruction to run it.
 * 3. A scan of the shipped source for the globals and spellings a hook cannot
 *    see -- `fetch`, `eval`, a child process that would open a socket on this
 *    package's behalf, and anything that would read a credential.
 */

const NETWORK_MODULES = [
  'net', 'http', 'https', 'http2', 'dgram', 'dns', 'tls', 'cluster', 'quic', 'inspector',
]

const HOOK_SOURCE = `
const blocked = new Set(${JSON.stringify(NETWORK_MODULES)})
export async function resolve(specifier, context, next) {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  if (blocked.has(bare.split('/')[0])) throw new Error('BLOCKED_NETWORK_IMPORT:' + specifier)
  return next(specifier, context)
}
`

const GUARD_SOURCE = `
import { register } from 'node:module'
register('./hook.mjs', import.meta.url)
`

const PROBE_SOURCE = `
import net from 'node:net'
process.stdout.write(typeof net)
`

async function withGuard(body) {
  const directory = await mkdtemp(join(tmpdir(), 'data-retention-guard-'))
  try {
    await writeFile(join(directory, 'hook.mjs'), HOOK_SOURCE)
    await writeFile(join(directory, 'guard.mjs'), GUARD_SOURCE)
    await writeFile(join(directory, 'probe.mjs'), PROBE_SOURCE)
    return await body({ directory, guard: pathToFileURL(join(directory, 'guard.mjs')).href })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the binary completes a real run with every network builtin refused at resolution', async () => {
  await withGuard(async ({ directory, guard }) => {
    // The control first: a script that does reach for a socket must fail under
    // the same guard, or this case would pass on a hook that never fires.
    await assert.rejects(
      () => execFileAsync(process.execPath, ['--import', guard, join(directory, 'probe.mjs')]),
      /BLOCKED_NETWORK_IMPORT:node:net/,
    )

    const { stdout } = await withRoot(clean(), (root) =>
      execFileAsync(process.execPath, ['--import', guard, CLI, '--root', root, '--json']))

    const report = JSON.parse(stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
  })
})

test('a live loopback address planted in the input is never contacted', async () => {
  const seen = { connections: 0, requests: 0 }
  const server = createServer((request, response) => {
    seen.requests += 1
    response.end('{}')
  })
  server.on('connection', () => {
    seen.connections += 1
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  try {
    const report = await apiReport(fixture(
      [dataClass('billing.invoices', 'finance-platform', {
        description: `catalog at http://127.0.0.1:${port}/classes`,
      })],
      [policy('billing.invoices', 'production', duration(1, 'year'), `store at http://127.0.0.1:${port}/store`)],
      [hold('matter-2031', 'released', ['billing.invoices'], `matter at http://127.0.0.1:${port}/matter`)],
      [job('nightly-sweep', ['billing.invoices'], `trigger at http://127.0.0.1:${port}/run`)],
    ))

    assert.equal(report.status, 'pass')
    assert.deepEqual(seen, { connections: 0, requests: 0 }, 'the listener on that exact port saw nothing at all')
  } finally {
    await new Promise((done) => server.close(done))
  }
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

test('the shipped source reaches for nothing that could open a socket', async () => {
  const source = await shippedSource()

  for (const name of NETWORK_MODULES) {
    assert.equal(source.includes(`node:${name}`), false, `the source imports node:${name}`)
  }
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'node:child_process', 'node:worker_threads', 'node:vm']) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
  assert.equal(/\bfetch\s*\(/.test(source), false, 'the source calls fetch')
  assert.equal(/\bnew\s+Request\b/.test(source), false)
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bnew\s+Function\b/.test(source), false)
})

test('the shipped source never reads a credential, a clock or a random number', async () => {
  const source = await shippedSource()

  for (const name of ['process.stdin', 'node:readline', 'process.env', 'getPassword', 'prompt(']) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }

  // Determinism: the only time source is the injected clock, and it is used for
  // a duration rather than for a date. Nothing here can put today's date into a
  // report, which is also why the tool cannot say a record is old enough to go.
  assert.equal(/\bDate\.now\b/.test(source), false)
  assert.equal(/\bnew\s+Date\b/.test(source), false)
  assert.equal(/\bMath\.random\b/.test(source), false)
  assert.equal(/\blocaleCompare\b/.test(source), false)
  assert.equal(/\bIntl\b/.test(source), false)
})

test('the manifest declares no dependency of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(Object.hasOwn(manifest, 'dependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'peerDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'optionalDependencies'), false)
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.engines.node, '>=22')
})
