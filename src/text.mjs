/**
 * Decoding, sanitising, ordering and the shapes an identifier is allowed to
 * take.
 *
 * Nothing in this module reads the filesystem, the network, a locale or a
 * clock. Every value it handles came out of a file this tool did not write, so
 * every value it returns is treated as data travelling towards a report and
 * never as something allowed to shape a line of that report.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * consults ICU data that differs between Node builds and between hosts, and it
 * weighs punctuation differently from its code point. Data-class ids and
 * environment names in this tool may carry upper case, `-`, `_`, `.` and `/`,
 * so a collated report would list a different class first, name a different
 * environment in a conflict, and recommend a different order of work on a
 * different machine. Every order this package exposes is decided here.
 *
 * Neither spelling of the locale-aware comparison appears anywhere in this
 * package, and `test/ordering.test.mjs` pins what the tool *emits* rather than
 * what its source says: a scan of the source cannot tell one comparator from
 * the other, so a scan is not the test.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * They are built from code points rather than written out, because a literal
 * U+2028 or U+2029 inside a module is a line terminator to the JavaScript
 * parser and the rest are invisible in an editor. Spelling each one keeps this
 * file plain ASCII and keeps the list reviewable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in the
 *   human summary, ESC opens a terminal escape sequence, NUL truncates a value
 *   in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two of them
 *   need no help at all: U+0085 NEL is a line break to a great many consumers
 *   and U+009B is the 8-bit CSI, a terminal control introducer that needs no
 *   ESC in front of it.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a class named `payroll` can be displayed as something else
 *   while the linter compares the real value -- and a reader deciding whether
 *   to let a deletion job run would be reading a different name from the one
 *   the report is about. Ordinary right-to-left text needs none of these: the
 *   letters carry their own direction, so refusing the overrides refuses
 *   nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- class ids,
 * hold ids, job ids, environment names, owners, file names, pointers, messages,
 * suggestions and evidence alike, not only an excerpt field. Tab, newline and
 * carriage return are deliberately left out of this class: `excerpt` collapses
 * them into a single space in the very next step, which reaches the same result
 * by a shorter route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What a value may not contain if it is to be used as a name: the same four
 * classes plus the three ASCII whitespace controls `CONTROL` leaves to the
 * collapse. A name gets no second pass. A data class whose printed id differs
 * from the id the linter compared is a class nobody can audit, so it is refused
 * at the door instead of being cleaned up and used.
 */
const FORBIDDEN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * True when any of the four classes appears anywhere in the string. Exported so
 * a test can walk an entire serialised report and assert that nothing survived
 * anywhere, rather than checking the one field somebody remembered to sanitise.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 120
export const MAX_LABEL_LENGTH = 120
export const MAX_DESCRIPTION_LENGTH = 300

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every id, environment, owner, file name, pointer, message and piece of
 * evidence that reaches a finding passes through here. A tool in this catalog
 * sanitised its evidence carefully and left its identifiers raw, so a record id
 * holding a newline printed two lines into the human report and invented a
 * finding that was never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * The name alphabet: data-class ids, environment names, legal-hold ids and
 * deletion-job ids.
 *
 * Wide enough for the spellings real exports use -- `customer.invoices`,
 * `pii/contact-details`, `matter-2031`, `eu-west-1:prod` -- which means upper
 * case, `.`, `:`, `/`, `+`, `-` and `_` all occur, which is in turn why order
 * in this package is decided by code unit and pinned by what the tool emits.
 *
 * The expression is one character class under one quantifier, so it is linear
 * in the length of its input, and the length is bounded before it ever runs.
 * This package compiles no pattern out of its input at all: there is no place
 * where a file being linted can choose what gets matched.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/

export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (FORBIDDEN.test(value)) return false
  return IDENTIFIER.test(value)
}

/**
 * A bounded piece of free text that names a human or a rule -- an owning team,
 * a regulation citation. Unlike an id it may carry spaces and punctuation,
 * because "Finance Platform" and "Companies Act 2013, s.128" are what these
 * fields really hold. It still may not carry a control, separator or bidi
 * character, and it is still excerpted on its way into a report.
 */
export function isLabel(value, limit = MAX_LABEL_LENGTH) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > limit) return false
  if (FORBIDDEN.test(value)) return false
  return value.trim().length > 0
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that gets piped, logged and pasted
 * somewhere more public than the input ever was. Echoing the value hands that
 * content a wider audience than it had, on exactly the fields whose validation
 * exists to keep something unexpected out of the report. The pointer on the
 * finding names the exact position in the file, which is all a reader needs.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains a
 * replacement character, and that confusion has already let an unread input
 * report a pass in this catalog. The decoder decides; the decoded text never
 * gets a vote. Every file this tool opens goes through here -- all four
 * documents, with no exception for the one a reviewer thinks of as
 * configuration.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
