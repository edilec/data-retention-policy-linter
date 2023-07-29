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

/**
 * The trap the first fix walked into: a file whose own text reads
 * `at position 1`.
 *
 * V8 answers it with `Unexpected token 'a', "at position 1" is not valid JSON`,
 * which carries BOTH spellings at once -- the quoted copy of the file, and,
 * inside that copy, something that reads exactly like an offset. A helper that
 * looks for the offset first finds the file's own text, slices the message
 * there, and ships the quoted span it was written to remove. The offset is only
 * safe once the quoting shape has been ruled out, so the quoting shape is
 * recognised first.
 *
 * `LEADING` is the seven characters of the canary that fit in front of
 * `at position 1` inside V8's twenty-character quoting window -- one more than
 * the six-character standard the rest of the suite holds the tool to.
 */

const LEADING = CANARY.slice(0, 7)

/** Every prefix of `text` from `length` characters down to six. */
function assertNoShortPrefix(haystack, needle, where) {
  for (let length = needle.length; length >= 6; length -= 1) {
    const prefix = needle.slice(0, length)
    assert.equal(haystack.includes(prefix), false, `${where} carried ${length} characters of "${needle}"`)
  }
}

const caught = (text) => {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    return error
  }
}

test('a file whose own text reads "at position 1" is not sliced back out of the message', () => {
  // The bare form first: the document IS the offset-looking text, so a
  // position-first helper returns the document.
  const bare = caught('at position 1')
  assert.equal(bare.message.includes('"at position 1"'), true, 'V8 still quotes it, so this test still has a subject')
  assert.equal(parseFailureDetail(bare), "unexpected token 'a' at the start of the document")

  // And with a credential in front of it, inside V8's twenty-character window.
  const planted = caught(`${LEADING}at position 1`)
  const detail = parseFailureDetail(planted)
  assert.equal(planted.message.includes(LEADING), true, 'V8 still quotes the canary, so this test still has a subject')
  assertNoShortPrefix(detail, LEADING, 'the detail')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a quoted span carrying a newline is still recognised as a quoted span', () => {
  // Twenty characters exactly, which is where V8 stops quoting the whole file
  // and starts quoting a window, so the span holds both a line break and the
  // offset-looking text. Without the `s` flag the quoting shape does not match
  // across the line break; the offset inside the span matches instead, and the
  // file comes back out.
  const error = caught(`${CANARY.slice(0, 6)}\nat position 1`)
  assert.equal(error.message.includes(CANARY.slice(0, 6)), true, 'V8 still quotes the canary, so this test still has a subject')
  assert.equal(error.message.includes('\n'), true, 'the quoted span still carries the newline')

  const detail = parseFailureDetail(error)
  assertNoShortPrefix(detail, CANARY.slice(0, 6), 'the detail')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a credential-only file and a long file with a credential prefix both keep only the token', () => {
  const whole = parseFailureDetail(caught(CANARY))
  assertNoShortPrefix(whole, CANARY, 'the detail for a credential-only file')
  assert.equal(whole, "unexpected token 'A' at the start of the document")

  const long = parseFailureDetail(caught(`${CANARY}${'-'.repeat(4000)}`))
  assertNoShortPrefix(long, CANARY, 'the detail for a long file with a sensitive prefix')
  assert.equal(long, "unexpected token 'A' at the start of the document")

  // A failure reached from the middle of the file says so rather than claiming
  // the start.
  const inside = parseFailureDetail(caught(`{"schemaVersion": "1", "classes": ${CANARY}}`))
  assertNoShortPrefix(inside, CANARY, 'the detail for a failure inside the file')
  assert.equal(inside, "unexpected token 'A' inside the document")
})

test('the safe positional spelling still carries position, line and column', () => {
  const detail = parseFailureDetail(caught('{"schemaVersion": "1" "classes": []}'))
  assert.match(detail, /at position \d+ \(line \d+ column \d+\)$/)
  assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)")
})

test('a quoting wording this build has never seen is refused wholesale', () => {
  // The closing guard, and the only thing standing between a future V8 wording
  // and the file it failed on. This message quotes the input and matches no
  // branch above; the offset inside the quoted span is the only thing that
  // matches, so without the guard the span ships.
  const unseen = { message: `Unexpected token 'A', "${LEADING} at position 5" is not valid JSON.` }
  const detail = parseFailureDetail(unseen)
  assertNoShortPrefix(detail, LEADING, 'the detail for an unrecognised wording')
  assert.equal(detail, 'the file could not be parsed as JSON')
})
