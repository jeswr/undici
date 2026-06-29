'use strict'

const { createServer } = require('node:http')
const { describe, test, after } = require('node:test')
const { once } = require('node:events')
const { Readable } = require('node:stream')
const assert = require('node:assert')
const { setTimeout: sleep } = require('node:timers/promises')
const { Client, interceptors, cacheStores: { MemoryCacheStore, SqliteCacheStore } } = require('../../index')
const { runtimeFeatures } = require('../../lib/util/runtime-features.js')

// RFC 10008 Section 2.7: the cache key for a QUERY request MUST incorporate the
// request content. These tests prove undici keys QUERY responses on a hash of
// the request body so different query bodies do not collide, while a repeated
// identical body is served from cache.
describe('QUERY body-aware caching (RFC 10008 Section 2.7)', () => {
  async function runCacheTest (makeStore) {
    let requestsToOrigin = 0
    const server = createServer((req, res) => {
      requestsToOrigin++
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.setHeader('cache-control', 's-maxage=10')
        res.end(`q=${body}#${requestsToOrigin}`)
      })
    }).listen(0)

    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache({ methods: ['GET', 'QUERY'], store: makeStore() }))

    after(async () => {
      server.close()
      await client.close()
    })
    await once(server, 'listening')

    const base = { origin: 'localhost', path: '/search', method: 'QUERY', headers: { 'content-type': 'application/sql' } }
    const text = async (body) => (await client.request({ ...base, body })).body.text()

    assert.strictEqual(await text('SELECT 1'), 'q=SELECT 1#1') // miss -> origin
    assert.strictEqual(await text('SELECT 1'), 'q=SELECT 1#1') // hit -> cached (no new origin hit)
    assert.strictEqual(await text('SELECT 2'), 'q=SELECT 2#2') // different body -> miss -> origin
    assert.strictEqual(await text('SELECT 2'), 'q=SELECT 2#2') // hit
    assert.strictEqual(requestsToOrigin, 2) // exactly two distinct queries reached origin
  }

  test('memory store: identical body cached, different body not collided', () => runCacheTest(() => new MemoryCacheStore()))

  test('sqlite store: identical body cached, different body not collided', { skip: runtimeFeatures.has('sqlite') === false }, () => runCacheTest(() => new SqliteCacheStore()))

  test('QUERY with a non-hashable (stream) body bypasses the cache', async () => {
    let requestsToOrigin = 0
    const server = createServer((req, res) => {
      requestsToOrigin++
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.setHeader('cache-control', 's-maxage=10')
        res.end(`q=${body}`)
      })
    }).listen(0)

    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache({ methods: ['GET', 'QUERY'], store: new MemoryCacheStore() }))
    after(async () => {
      server.close()
      await client.close()
    })
    await once(server, 'listening')

    const base = { origin: 'localhost', path: '/search', method: 'QUERY', headers: { 'content-type': 'application/sql' } }
    assert.strictEqual(await (await client.request({ ...base, body: Readable.from(['SELECT 1']) })).body.text(), 'q=SELECT 1')
    assert.strictEqual(await (await client.request({ ...base, body: Readable.from(['SELECT 1']) })).body.text(), 'q=SELECT 1')
    // Stream bodies cannot be hashed, so each request bypasses the cache.
    assert.strictEqual(requestsToOrigin, 2)
  })
})

describe('QUERY body-aware deduplication', () => {
  test('concurrent identical-body QUERYs are deduplicated; different-body QUERYs are not', async () => {
    let requestsToOrigin = 0
    const server = createServer((req, res) => {
      requestsToOrigin++
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        await sleep(100) // keep the request in-flight so concurrent ones overlap
        res.end(`q=${body}#${requestsToOrigin}`)
      })
    }).listen(0)

    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.deduplicate({ methods: ['QUERY'] }))
    after(async () => {
      server.close()
      await client.close()
    })
    await once(server, 'listening')

    const base = { origin: 'localhost', path: '/search', method: 'QUERY', headers: { 'content-type': 'application/sql' } }
    const req = (body) => client.request({ ...base, body }).then((r) => r.body.text())

    // Same body, concurrent: collapsed into one origin request.
    const [a, b] = await Promise.all([req('SAME'), req('SAME')])
    assert.strictEqual(a, b)
    assert.strictEqual(requestsToOrigin, 1)

    // Different bodies, concurrent: must NOT be deduplicated together.
    const [x, y] = await Promise.all([req('XX'), req('YY')])
    assert.notStrictEqual(x, y)
    assert.ok(x.startsWith('q=XX'), `expected XX response, got ${x}`)
    assert.ok(y.startsWith('q=YY'), `expected YY response, got ${y}`)
    assert.strictEqual(requestsToOrigin, 3)
  })
})
