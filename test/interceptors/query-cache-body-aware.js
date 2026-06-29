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

  test('streaming body within the cap is cached (identical) and not collided (different)', async () => {
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
      .compose(interceptors.cache({ methods: ['GET', 'QUERY'], store: new MemoryCacheStore() }))
    after(async () => {
      server.close()
      await client.close()
    })
    await once(server, 'listening')

    const base = { origin: 'localhost', path: '/search', method: 'QUERY', headers: { 'content-type': 'application/sql' } }
    // Stream bodies are buffered up to the cap, hashed, and cached.
    assert.strictEqual(await (await client.request({ ...base, body: Readable.from(['SELECT 1']) })).body.text(), 'q=SELECT 1#1') // miss
    assert.strictEqual(await (await client.request({ ...base, body: Readable.from(['SELECT 1']) })).body.text(), 'q=SELECT 1#1') // hit (cached)
    assert.strictEqual(await (await client.request({ ...base, body: Readable.from(['SELECT 2']) })).body.text(), 'q=SELECT 2#2') // different body -> miss
    assert.strictEqual(requestsToOrigin, 2)
  })

  test('streaming body larger than the cap is forwarded uncached, with the full body delivered', async () => {
    let requestsToOrigin = 0
    let lastLen = 0
    const server = createServer((req, res) => {
      requestsToOrigin++
      let len = 0
      req.on('data', (chunk) => { len += chunk.length })
      req.on('end', () => {
        lastLen = len
        res.setHeader('cache-control', 's-maxage=10')
        res.end('ok')
      })
    }).listen(0)

    // Tiny cap so a modest body overflows it without allocating anything large.
    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache({ methods: ['GET', 'QUERY'], store: new MemoryCacheStore(), maxRequestBodyKeySize: 16 }))
    after(async () => {
      server.close()
      await client.close()
    })
    await once(server, 'listening')

    const base = { origin: 'localhost', path: '/search', method: 'QUERY', headers: { 'content-type': 'application/sql' } }
    // Body of 1000 bytes split across chunks, exceeding the 16-byte cap.
    const makeBody = () => Readable.from([Buffer.alloc(400, 1), Buffer.alloc(600, 2)])
    await (await client.request({ ...base, body: makeBody() })).body.text()
    assert.strictEqual(lastLen, 1000) // full body delivered to origin after reconstruction
    await (await client.request({ ...base, body: makeBody() })).body.text()
    assert.strictEqual(lastLen, 1000)
    // Over-cap bodies are not cached, so both requests reached the origin.
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

  test('concurrent streaming-body QUERYs within the cap are deduplicated by body content', async () => {
    let requestsToOrigin = 0
    const server = createServer((req, res) => {
      requestsToOrigin++
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        await sleep(100)
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
    const req = (chunks) => client.request({ ...base, body: Readable.from(chunks) }).then((r) => r.body.text())

    // Concurrent identical streaming bodies: deduplicated (buffered, hashed, matched).
    const [a, b] = await Promise.all([req(['SELECT ', '1']), req(['SELECT ', '1'])])
    assert.strictEqual(a, b)
    assert.strictEqual(requestsToOrigin, 1)

    // Concurrent different streaming bodies: dispatched independently.
    const [x, y] = await Promise.all([req(['SELECT ', '2']), req(['SELECT ', '3'])])
    assert.notStrictEqual(x, y)
    assert.strictEqual(requestsToOrigin, 3)
  })
})
