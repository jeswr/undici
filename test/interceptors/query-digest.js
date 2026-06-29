'use strict'

// EXPERIMENTAL / FORK-ONLY PROTOTYPE test for the queryDigest interceptor
// (draft-query-digest-caching). Do NOT upstream.
//
// UNIT coverage (passing): the interceptor computes the RFC 9530 Content-Digest
// of a re-readable Blob body by *streaming* it (no full buffer), sets
// `expectContinue: true`, and forwards a fresh body stream — i.e. the entire
// client-side preparation for digest-based body-withholding.
//
// END-TO-END coverage (SKIPPED — records a finding): the upload-avoidance
// short-circuit cannot yet be demonstrated against undici's HTTP/2 client.
// Investigation (see PR description) showed that when a server returns a final
// response in lieu of `100 (Continue)`, the h2 request hangs: undici binds the
// body write to the stream's 'continue' event and does not deliver the early
// 'response' or close the half-open request stream. Making the prototype work
// end to end therefore requires a *core* h2 change (deliver a final response
// received while awaiting 100 (Continue), and RST/close the request stream
// without sending the body). That is the concrete implementability gap this
// prototype surfaces for the draft.

const { test } = require('node:test')
const assert = require('node:assert')
const { createHash } = require('node:crypto')
const queryDigest = require('../../lib/interceptor/query-digest.js')

function capture (interceptor, opts) {
  let captured = null
  const dispatch = (o) => { captured = o; return true }
  const ret = interceptor(dispatch)(opts, {})
  return { ret, getCaptured: () => captured }
}

test('queryDigest computes the Content-Digest of a Blob body and sets Expect:100-continue', async () => {
  const content = Buffer.from('SELECT * FROM t WHERE id = 1')
  const expected = `sha-256=:${createHash('sha256').update(content).digest('base64')}:`

  const { ret, getCaptured } = capture(queryDigest(), {
    origin: 'https://example.org',
    method: 'QUERY',
    path: '/search',
    headers: { 'content-type': 'application/sql' },
    body: new Blob([content])
  })
  await ret // the interceptor hashes asynchronously before dispatching

  const opts = getCaptured()
  assert.ok(opts, 'request was dispatched')
  assert.strictEqual(opts.headers['content-digest'], expected)
  assert.strictEqual(opts.expectContinue, true)
  assert.strictEqual(typeof opts.body.getReader, 'function', 'body forwarded as a fresh ReadableStream')
})

test('queryDigest computes a sha-512 digest when configured', async () => {
  const content = Buffer.from('SELECT 2')
  const expected = `sha-512=:${createHash('sha512').update(content).digest('base64')}:`
  const { ret, getCaptured } = capture(queryDigest({ algorithm: 'sha-512' }), {
    origin: 'https://example.org', method: 'QUERY', path: '/s', headers: {}, body: new Blob([content])
  })
  await ret
  assert.strictEqual(getCaptured().headers['content-digest'], expected)
})

test('queryDigest passes through non-QUERY methods unchanged', async () => {
  const input = { origin: 'https://example.org', method: 'GET', path: '/', headers: {}, body: new Blob([Buffer.from('x')]) }
  const { ret, getCaptured } = capture(queryDigest(), input)
  await ret
  const opts = getCaptured()
  assert.strictEqual(opts, input, 'opts forwarded unchanged')
  assert.strictEqual(opts.expectContinue, undefined)
})

test('queryDigest passes through non-Blob (one-shot) bodies unchanged', async () => {
  const input = { origin: 'https://example.org', method: 'QUERY', path: '/', headers: {}, body: 'SELECT 1' }
  const { ret, getCaptured } = capture(queryDigest(), input)
  await ret
  const opts = getCaptured()
  assert.strictEqual(opts, input)
  assert.strictEqual(opts.headers['content-digest'], undefined)
})

test('queryDigest does not override an existing Content-Digest', async () => {
  const input = {
    origin: 'https://example.org',
    method: 'QUERY',
    path: '/',
    body: new Blob([Buffer.from('x')]),
    headers: { 'content-digest': 'sha-256=:preset:' }
  }
  const { ret, getCaptured } = capture(queryDigest(), input)
  await ret
  assert.strictEqual(getCaptured(), input)
})

test('queryDigest rejects unsupported algorithms at construction', () => {
  assert.throws(() => queryDigest({ algorithm: 'md5' }), TypeError)
})

// See header comment: blocked on a core HTTP/2 change before it can pass.
test('queryDigest avoids uploading the body when the server holds the digest (HTTP/2)', { skip: 'requires core h2 support for final-response-before-100-continue; see PR description' }, () => {})
