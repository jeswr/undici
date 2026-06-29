'use strict'

const { createServer } = require('node:http')
const { describe, test, after } = require('node:test')
const { once } = require('node:events')
const assert = require('node:assert')
const { Client, interceptors } = require('../../index')

// RFC 10008 (HTTP QUERY) makes QUERY a safe, idempotent, cacheable method whose
// response is determined by the request content (Section 2.7 requires the cache
// key to incorporate it). undici's cache/deduplication key is body-blind
// (origin + method + path + headers), so QUERY must not be accepted by the
// cache or deduplicate interceptors until the key is body-aware — otherwise two
// QUERY requests to the same URL with different bodies would collide.
describe('QUERY method cache/dedup safety (RFC 10008 Section 2.7)', () => {
  test('cache interceptor rejects QUERY in opts.methods', () => {
    assert.throws(
      () => interceptors.cache({ methods: ['QUERY'] }),
      (err) => err instanceof TypeError && /QUERY/.test(err.message) && /2\.7/.test(err.message)
    )
    assert.throws(
      () => interceptors.cache({ methods: ['GET', 'QUERY'] }),
      (err) => err instanceof TypeError && /QUERY/.test(err.message)
    )
  })

  test('deduplicate interceptor rejects QUERY in opts.methods', () => {
    assert.throws(
      () => interceptors.deduplicate({ methods: ['QUERY'] }),
      (err) => err instanceof TypeError && /QUERY/.test(err.message)
    )
    assert.throws(
      () => interceptors.deduplicate({ methods: ['GET', 'QUERY'] }),
      (err) => err instanceof TypeError && /QUERY/.test(err.message)
    )
  })

  test('default cache and deduplicate interceptors still construct', () => {
    assert.doesNotThrow(() => interceptors.cache())
    assert.doesNotThrow(() => interceptors.deduplicate())
    // GET-only configuration remains valid
    assert.doesNotThrow(() => interceptors.cache({ methods: ['GET'] }))
    assert.doesNotThrow(() => interceptors.deduplicate({ methods: ['GET', 'HEAD'] }))
  })

  test('QUERY is never served from a body-blind cache: different bodies do not collide', async () => {
    let requestsToOrigin = 0
    const server = createServer({ joinDuplicateHeaders: true }, (req, res) => {
      requestsToOrigin++
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        // Cacheable response; if QUERY were (wrongly) cached by a body-blind
        // key, the second request below would be served this first body.
        res.setHeader('cache-control', 's-maxage=10')
        res.end(`query=${body}`)
      })
    }).listen(0)

    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache())

    after(async () => {
      server.close()
      await client.close()
    })

    await once(server, 'listening')
    assert.strictEqual(requestsToOrigin, 0)

    const base = {
      origin: 'localhost',
      path: '/search',
      method: 'QUERY',
      headers: { 'content-type': 'application/sql' }
    }

    const res1 = await client.request({ ...base, body: 'SELECT 1' })
    const body1 = await res1.body.text()
    assert.strictEqual(body1, 'query=SELECT 1')
    assert.strictEqual(requestsToOrigin, 1)

    // Same origin/path/headers, DIFFERENT body. A body-blind cache would return
    // 'query=SELECT 1' here and leave requestsToOrigin at 1.
    const res2 = await client.request({ ...base, body: 'SELECT 2' })
    const body2 = await res2.body.text()
    assert.strictEqual(body2, 'query=SELECT 2')
    assert.strictEqual(requestsToOrigin, 2)
  })
})
