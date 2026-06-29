'use strict'

const { createServer } = require('node:http')
const { test, describe, after } = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const { Agent, interceptors, request } = require('..')
const coreUtil = require('../lib/core/util')
const fetchConstants = require('../lib/web/fetch/constants')

// Conformance tests for the HTTP QUERY method (RFC 10008) as added in
// nodejs/undici#5459. QUERY is a safe, idempotent, cacheable method that
// carries a request body. These tests lock in the behaviours that were
// verified correct during review so future refactors cannot silently break
// them.

describe('QUERY method: redirects (RFC 10008 Section 2.5)', () => {
  // A QUERY redirect must send "a similar QUERY request to the new target URI"
  // for 301/302/307/308 (the POST->GET downgrade exception does NOT apply to
  // QUERY), and downgrade to GET for 303.
  function buildServer () {
    return createServer((req, res) => {
      const m = /^\/from-(\d+)$/.exec(req.url)
      if (m) {
        res.writeHead(Number(m[1]), { location: '/target' })
        res.end()
        return
      }
      if (req.url === '/target') {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            method: req.method,
            body,
            contentType: req.headers['content-type'] ?? null
          }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
  }

  async function redirectQuery (status) {
    const server = buildServer().listen(0)
    const dispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: 5 }))
    after(async () => {
      server.close()
      await dispatcher.close()
    })
    await once(server, 'listening')
    const origin = `http://localhost:${server.address().port}`

    const { statusCode, body } = await request(`${origin}/from-${status}`, {
      dispatcher,
      method: 'QUERY',
      headers: { 'content-type': 'application/sql' },
      body: 'SELECT 1',
      maxRedirections: 5
    })
    assert.strictEqual(statusCode, 200)
    return JSON.parse(await body.text())
  }

  for (const status of [301, 302, 307, 308]) {
    test(`${status} preserves the QUERY method, body and Content-Type`, async () => {
      const result = await redirectQuery(status)
      assert.strictEqual(result.method, 'QUERY')
      assert.strictEqual(result.body, 'SELECT 1')
      assert.strictEqual(result.contentType, 'application/sql')
    })
  }

  test('303 changes the QUERY to GET and drops the body and Content-Type', async () => {
    const result = await redirectQuery(303)
    assert.strictEqual(result.method, 'GET')
    assert.strictEqual(result.body, '')
    assert.strictEqual(result.contentType, null)
  })
})

describe('QUERY method: classification and normalization', () => {
  test('QUERY is a safe HTTP method', () => {
    assert.ok(coreUtil.safeHTTPMethods.includes('QUERY'))
  })

  test('normalizedMethodRecords maps query/QUERY to QUERY', () => {
    assert.strictEqual(coreUtil.normalizedMethodRecords.query, 'QUERY')
    assert.strictEqual(coreUtil.normalizedMethodRecords.QUERY, 'QUERY')
  })

  test('QUERY is a fetch safe method but NOT CORS-safelisted (preflight required, RFC 10008 Section 4)', () => {
    assert.ok(fetchConstants.safeMethodsSet.has('QUERY'))
    assert.ok(!fetchConstants.corsSafeListedMethodsSet.has('QUERY'))
  })

  test('the dispatcher sends QUERY (with a body) on the wire', async () => {
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => res.end(`${req.method}:${body}`))
    }).listen(0)
    after(() => server.close())
    await once(server, 'listening')
    const origin = `http://localhost:${server.address().port}`

    const { statusCode, body } = await request(origin, {
      method: 'QUERY',
      headers: { 'content-type': 'application/sql' },
      body: 'SELECT 1'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(await body.text(), 'QUERY:SELECT 1')
  })
})

describe('QUERY method: retry/idempotency (RFC 10008 Section 2)', () => {
  test('a QUERY with a replayable body is retried on a retryable status (503 -> 200)', async () => {
    let attempts = 0
    const server = createServer((req, res) => {
      attempts++
      if (attempts === 1) {
        res.writeHead(503)
        res.end('try again')
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.writeHead(200)
        res.end(`ok:${body}`)
      })
    }).listen(0)
    const dispatcher = new Agent().compose(
      interceptors.retry({ maxRetries: 3, minTimeout: 10, maxTimeout: 50 })
    )
    after(async () => {
      server.close()
      await dispatcher.close()
    })
    await once(server, 'listening')
    const origin = `http://localhost:${server.address().port}`

    const { statusCode, body } = await request(origin, {
      dispatcher,
      method: 'QUERY',
      headers: { 'content-type': 'application/sql' },
      body: 'SELECT 1'
    })
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(await body.text(), 'ok:SELECT 1') // body replayed on retry
    assert.strictEqual(attempts, 2) // retried exactly once
  })
})
