import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT,
  MAX_IDENTIFIER_LENGTH,
  MAX_LABEL_LENGTH,
  byCodeUnit,
  decodeUtf8,
  describeValue,
  excerpt,
  hasForbiddenCharacter,
  isIdentifier,
  isLabel,
  isPlainObject,
} from '../src/index.mjs'
import { FORBIDDEN } from './support.mjs'

/** The primitives every other module leans on, checked on their own terms. */

test('decoding is the decoder decision and never an inference from the decoded text', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x7b, 0x7d])), { ok: true, text: '{}' })

  // A lone continuation byte is not UTF-8 and no amount of looking at the
  // result would say so as reliably as the decoder refusing it.
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0xc3, 0x28])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0xe2, 0x82])).ok, false)

  // A file that legitimately holds U+FFFD decodes, which is the case a lenient
  // decoder plus a search for U+FFFD cannot tell from the ones above.
  const replacement = new TextEncoder().encode('"�"')
  assert.deepEqual(decodeUtf8(replacement), { ok: true, text: '"�"' })
})

test('excerpt flattens, bounds and strips every class the contract names', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const flattened = excerpt(`before${character}after`)
    assert.equal(hasForbiddenCharacter(flattened), false, name)
    assert.equal(flattened.includes('before'), true, name)
    assert.equal(flattened.includes('after'), true, name)
  }

  assert.equal(excerpt('  spaced \t out  '), 'spaced out')
  assert.equal(excerpt('a'.repeat(EXCERPT_LIMIT)), 'a'.repeat(EXCERPT_LIMIT))
  assert.equal(excerpt('a'.repeat(EXCERPT_LIMIT + 1)), `${'a'.repeat(EXCERPT_LIMIT)}...`)
  assert.equal(excerpt('abcdef', 3), 'abc...')
  assert.equal(excerpt(42), '42')
})

test('an identifier is a name, bounded, and free of every forbidden class', () => {
  for (const id of ['a', 'billing.invoices', 'pii/contact-details', 'eu-west-1:prod', 'A+B', 'x_y', '9lives']) {
    assert.equal(isIdentifier(id), true, id)
  }
  for (const id of ['', '.leading', '-leading', 'has space', 'has"quote', 'a'.repeat(MAX_IDENTIFIER_LENGTH + 1), 4, null, undefined, {}]) {
    assert.equal(isIdentifier(id), false, String(id))
  }
  assert.equal(isIdentifier('a'.repeat(MAX_IDENTIFIER_LENGTH)), true)
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(isIdentifier(`billing${character}invoices`), false, name)
  }
})

test('a label may carry spaces and punctuation but not a control, separator or bidi character', () => {
  assert.equal(isLabel('Finance Platform'), true)
  assert.equal(isLabel('Companies Act 2013, s.128'), true)
  assert.equal(isLabel('   '), false, 'whitespace alone names nobody')
  assert.equal(isLabel(''), false)
  assert.equal(isLabel('a'.repeat(MAX_LABEL_LENGTH)), true)
  assert.equal(isLabel('a'.repeat(MAX_LABEL_LENGTH + 1)), false)
  assert.equal(isLabel(7), false)
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(isLabel(`Finance${character}Platform`), false, name)
  }
})

test('a refused value is described, never reproduced', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue('secret'), 'a string of 6 character(s)')
  assert.equal(describeValue([1, 2]), 'an array of 2 item(s)')
  assert.equal(describeValue({}), 'an object')
  assert.equal(describeValue('secret').includes('secret'), false)
})

test('byCodeUnit orders by code unit and reports ties as ties', () => {
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1, 'uppercase precedes lowercase by code point')
  assert.equal(byCodeUnit('a-b', 'a_b'), -1, 'and a hyphen precedes an underscore')
})

test('isPlainObject refuses arrays, null and anything with an inherited prototype', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Map()), false)
  assert.equal(isPlainObject(new Date(0)), false)
})
