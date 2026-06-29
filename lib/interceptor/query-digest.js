'use strict'

const { createHash } = require('node:crypto')

// EXPERIMENTAL / FORK-ONLY PROTOTYPE — do NOT upstream.
//
// Prototype of draft-wright-httpbis-query-digest-caching: avoid re-uploading a
// large QUERY (RFC 10008) body when a digest-aware cache already holds the
// result. For a QUERY whose body is a re-readable Blob, this interceptor:
//   1. stream-hashes the Blob to compute a Content-Digest (RFC 9530) WITHOUT
//      buffering the whole body in memory;
//   2. sets `expectContinue: true` so undici sends the headers and withholds
//      the body until the server replies `100 (Continue)` (HTTP/2 only — h1
//      does not support 100-continue in undici and will not benefit);
//   3. dispatches a *fresh* Blob stream as the body.
// If a digest-aware server short-circuits with a final response instead of
// `100 (Continue)`, undici never reads the body — the upload is skipped.
//
// This is purely the client half of an unratified protocol extension; it is
// inert against servers that don't implement it (they send 100, body uploads
// as normal). See drafts/draft-query-digest-caching.md.

const SUPPORTED = {
  'sha-256': 'sha256',
  'sha-512': 'sha512'
}

/**
 * @param {{ methods?: string[], algorithm?: 'sha-256' | 'sha-512' }} [opts]
 */
module.exports = (opts = {}) => {
  const { methods = ['QUERY'], algorithm = 'sha-256' } = opts

  const nodeAlgorithm = SUPPORTED[algorithm]
  if (nodeAlgorithm == null) {
    throw new TypeError(`unsupported digest algorithm: ${algorithm} (expected one of ${Object.keys(SUPPORTED).join(', ')})`)
  }
  if (!Array.isArray(methods)) {
    throw new TypeError(`expected opts.methods to be an array, got ${typeof methods}`)
  }

  return dispatch => {
    return (opts, handler) => {
      // Only act on configured methods with a re-readable Blob body that does
      // not already carry a Content-Digest.
      if (!methods.includes(opts.method) || !isReReadableBlob(opts.body) || hasContentDigest(opts.headers)) {
        return dispatch(opts, handler)
      }

      const blob = opts.body
      // Stream-hash without buffering the whole body.
      return hashBlob(blob, nodeAlgorithm).then(digest => {
        return dispatch({
          ...opts,
          headers: withContentDigest(opts.headers, `${algorithm}=:${digest}:`),
          // A fresh stream for the (possible) upload; the hashing read above is
          // a separate, independent read of the same re-readable source.
          body: blob.stream(),
          expectContinue: true
        }, handler)
      })
    }
  }
}

/**
 * @param {unknown} body
 * @returns {boolean}
 */
function isReReadableBlob (body) {
  return body != null &&
    typeof body === 'object' &&
    typeof body.stream === 'function' &&
    typeof body.size === 'number'
}

/**
 * @param {Blob} blob
 * @param {string} nodeAlgorithm
 * @returns {Promise<string>} base64 digest
 */
async function hashBlob (blob, nodeAlgorithm) {
  const hash = createHash(nodeAlgorithm)
  for await (const chunk of blob.stream()) {
    hash.update(chunk)
  }
  return hash.digest('base64')
}

function hasContentDigest (headers) {
  if (headers == null) return false
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === 'content-digest') return true
    }
    return false
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-digest') return true
    }
  }
  return false
}

function withContentDigest (headers, value) {
  if (Array.isArray(headers)) {
    return [...headers, 'content-digest', value]
  }
  if (headers == null) {
    return { 'content-digest': value }
  }
  return { ...headers, 'content-digest': value }
}
