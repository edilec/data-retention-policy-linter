import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/text.mjs'
import { clean, cliRun, withRoot } from './support.mjs'

/**
 * A parse failure does not quote the file it failed on.
 *
 * V8 reports a parse failure two ways, and one of them embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The
 * `input-not-json` finding interpolated that message, so a retention file short
 * enough to be nothing but a credential was reproduced in full on stdout, on
 * exactly the path an untrusted or malformed file takes. `excerpt` never helped
 * and never could: it cuts from the end and the quoted span is at the front.
 *
 * The canary is the AWS documentation placeholder, not a key. Every assertion
 * walks it down to eight characters, because V8 quotes a ten-character window
 * once the input is long enough: asserting only the whole string passes while
 * ten characters of the secret still ship.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

/** Every prefix of the canary from its full length down to eight characters. */
function assertNoPrefix(text, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(text.includes(prefix), false, `${where} carried ${length} characters of the canary`)
  }
}

/** Run the real binary over a root whose `classes.json` is the given text. */
async function runWith(text, extraArgs = []) {
  return withRoot({ ...clean(), 'classes.json': text }, async (root) => {
    const result = await cliRun(['--root', root, ...extraArgs])
    assertNoPrefix(result.stdout, 'stdout')
    assertNoPrefix(result.stderr, 'stderr')
    return result
  })
}

test('a file that is only a credential is not echoed by its own parse error', async () => {
  const { code, stdout } = await runWith(CANARY, ['--json'])
  assert.equal(code, 2)

  const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'input-not-json')
  assert.notEqual(finding, undefined, 'the run still said the file was not JSON')
  assert.match(finding.message, /token/, 'the diagnostic still says what went wrong')
})

test('the human report does not echo it either', async () => {
  const { code, stderr } = await runWith(CANARY)
  assert.equal(code, 2)
  assert.match(stderr, /input-not-json/, 'the human report still names the rule')
})

test('a file that fails after a valid property keeps its position, line and column', async () => {
  // V8 answers this one with the safe spelling: a position and no quoted span.
  // A parse error that says nothing is a different defect.
  const { stdout } = await runWith(`{"schemaVersion": "1" ${CANARY}}`, ['--json'])

  const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'input-not-json')
  assert.match(finding.message, /at position \d+/, 'the position a reader needs is still there')
  assert.match(finding.message, /line \d+ column \d+/, 'line and column are still there')
})

test('a secret deep inside a longer file is not echoed by the windowed spelling', async () => {
  // The third V8 spelling quotes a window rather than a prefix and carries no
  // position; only the offending token survives it.
  const { stdout } = await runWith(`{"schemaVersion": "1", "classes": ${CANARY}}`, ['--json'])

  const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'input-not-json')
  assert.match(finding.message, /unexpected token/)
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const caught = (text) => {
    try {
      JSON.parse(text)
      return null
    } catch (error) {
      return error
    }
  }

  const quoted = caught(CANARY)
  assert.equal(quoted.message.includes(CANARY), true, 'V8 still quotes the input, so this test still has a subject')
  assert.equal(parseFailureDetail(quoted).includes(CANARY.slice(0, SHORTEST_PREFIX)), false)

  const detail = parseFailureDetail(caught(`{"a": 1 ${CANARY}}`))
  assert.equal(detail.includes(CANARY.slice(0, SHORTEST_PREFIX)), false)
  assert.match(detail, /at position \d+ \(line \d+ column \d+\)$/)

  assert.equal(parseFailureDetail(caught('password=hunter2-correct-horse')).includes('password'), false)
  assert.equal(parseFailureDetail(caught('')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(undefined), 'the file could not be parsed as JSON')
})
