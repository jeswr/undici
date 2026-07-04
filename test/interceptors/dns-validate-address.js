'use strict'

const { test, after } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')

const { tspl } = require('@matteo.collina/tspl')

const { interceptors, Agent, errors, fetch, request } = require('../..')
const { dns } = interceptors

function localLookup () {
  return (_origin, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])
}

async function startServer (onRequest, host = '127.0.0.1') {
  const server = createServer({ joinDuplicateHeaders: true }, onRequest)
  server.listen(0, host)
  await once(server, 'listening')
  return server
}

function closeServer (server) {
  return async () => {
    server.close()
    await once(server, 'close')
  }
}

// Probe whether the IPv6 loopback is bindable (some CI environments lack ::1)
function ipv6LoopbackAvailable () {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '::1', () => {
      probe.close(() => resolve(true))
    })
  })
}

test('Should validate validateAddress option', t => {
  t = tspl(t, { plan: 2 })

  t.throws(() => dns({ validateAddress: 'nope' }), { code: 'UND_ERR_INVALID_ARG' })
  t.throws(() => dns({ validateAddress: {} }), { code: 'UND_ERR_INVALID_ARG' })
})

test('Should refuse a hostname whose resolved address fails validateAddress', async t => {
  t = tspl(t, { plan: 8 })

  let hits = 0
  const server = await startServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('should never be reached')
  })
  const port = server.address().port

  const seen = []
  const agent = new Agent().compose(dns({
    lookup: localLookup(),
    validateAddress: (address, family, origin) => {
      seen.push(`${address}/${family}/${origin.hostname}`)
      return false
    }
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  try {
    await request(`http://blocked.example:${port}/`, { dispatcher: agent })
    t.fail('request should have been refused')
  } catch (err) {
    t.ok(err instanceof errors.AddressBlockedError)
    t.equal(err.code, 'UND_ERR_ADDRESS_BLOCKED')
    t.equal(err.address, '127.0.0.1')
    t.equal(err.family, 4)
    t.equal(err.hostname, 'blocked.example')
  }

  t.deepStrictEqual(seen, ['127.0.0.1/4/blocked.example'])
  // The refusal must happen before any connection is dialed
  t.equal(hits, 0)
  t.ok(true)
})

test('Should refuse the whole record set when a single record fails validateAddress', async t => {
  t = tspl(t, { plan: 4 })

  let hits = 0
  const server = await startServer((_req, res) => {
    hits++
    res.end('nope')
  })
  const port = server.address().port

  const validated = []
  const agent = new Agent().compose(dns({
    lookup: (_origin, _opts, cb) => cb(null, [
      { address: '203.0.113.7', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]),
    // Only the first record is allowed — the mixed set must be refused as a whole
    // (a partially-refused set is a DNS-rebinding signal), so the allowed record
    // must not be dialed either.
    validateAddress: (address) => {
      validated.push(address)
      return address === '203.0.113.7'
    }
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  try {
    await request(`http://rebind.example:${port}/`, { dispatcher: agent })
    t.fail('request should have been refused')
  } catch (err) {
    t.ok(err instanceof errors.AddressBlockedError)
    t.equal(err.address, '127.0.0.1')
  }

  t.deepStrictEqual(validated, ['203.0.113.7', '127.0.0.1'])
  t.equal(hits, 0)
})

test('Should dispatch (pinned) when every resolved address passes validateAddress', async t => {
  t = tspl(t, { plan: 5 })

  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello world!')
  })
  const port = server.address().port

  const seen = []
  const agent = new Agent().compose(dns({
    lookup: localLookup(),
    validateAddress: (address, family, origin) => {
      seen.push(`${address}/${family}/${origin.hostname}`)
      return address === '127.0.0.1'
    }
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  const response = await request(`http://svc.example:${port}/`, { dispatcher: agent })

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'hello world!')
  t.deepStrictEqual(seen, ['127.0.0.1/4/svc.example'])

  // Cached records were validated when inserted — no re-validation on a cache hit
  const response2 = await request(`http://svc.example:${port}/`, { dispatcher: agent })
  t.equal(response2.statusCode, 200)
  await response2.body.text()
  t.equal(seen.length, 1)
})

test('Should propagate a custom error thrown by validateAddress', async t => {
  t = tspl(t, { plan: 2 })

  class PolicyError extends Error {}

  const server = await startServer((_req, res) => res.end('nope'))
  const port = server.address().port

  const agent = new Agent().compose(dns({
    lookup: localLookup(),
    validateAddress: () => {
      throw new PolicyError('loopback address refused by policy')
    }
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  try {
    await request(`http://custom-error.example:${port}/`, { dispatcher: agent })
    t.fail('request should have been refused')
  } catch (err) {
    t.ok(err instanceof PolicyError)
    t.equal(err.message, 'loopback address refused by policy')
  }
})

test('Should validate an IPv4-literal origin instead of bypassing the policy', async t => {
  t = tspl(t, { plan: 6 })

  let hits = 0
  const server = await startServer((_req, res) => {
    hits++
    res.end('nope')
  })
  const port = server.address().port

  let lookupCalls = 0
  const agent = new Agent().compose(dns({
    lookup: (_origin, _opts, cb) => {
      lookupCalls++
      cb(null, [{ address: '127.0.0.1', family: 4 }])
    },
    validateAddress: () => false
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  try {
    await request(`http://127.0.0.1:${port}/`, { dispatcher: agent })
    t.fail('request should have been refused')
  } catch (err) {
    t.ok(err instanceof errors.AddressBlockedError)
    t.equal(err.address, '127.0.0.1')
    t.equal(err.family, 4)
  }

  // A literal is refused without resolving anything and without dialing
  t.equal(lookupCalls, 0)
  t.equal(hits, 0)
  t.ok(true)
})

test('Should pass an allowed IP-literal origin through unchanged', async t => {
  t = tspl(t, { plan: 3 })

  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello literal!')
  })
  const port = server.address().port

  let lookupCalls = 0
  const agent = new Agent().compose(dns({
    lookup: (_origin, _opts, cb) => {
      lookupCalls++
      cb(null, [{ address: '127.0.0.1', family: 4 }])
    },
    validateAddress: (address) => address === '127.0.0.1'
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  const response = await request(`http://127.0.0.1:${port}/`, { dispatcher: agent })

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'hello literal!')
  t.equal(lookupCalls, 0)
})

test('Should recognize a bracketed IPv6-literal origin as a literal', async t => {
  if (!await ipv6LoopbackAvailable()) {
    t.skip('IPv6 loopback not available')
    return
  }

  t = tspl(t, { plan: 5 })

  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello v6!')
  }, '::1')
  const port = server.address().port

  // Without the bracket-stripping fix, "[::1]" fails isIP() and is handed to the
  // resolver as if it were a hostname (the default resolver then fails with ENOTFOUND).
  const seen = []
  const agent = new Agent().compose(dns({
    validateAddress: (address, family) => {
      seen.push(`${address}/${family}`)
      return true
    }
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  const response = await request(`http://[::1]:${port}/`, { dispatcher: agent })

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'hello v6!')
  // The validator sees the unbracketed address
  t.deepStrictEqual(seen, ['::1/6'])

  // And a refusing policy blocks the IPv6 literal as well
  const blocking = new Agent().compose(dns({ validateAddress: () => false }))
  after(() => blocking.close())
  try {
    await request(`http://[::1]:${port}/`, { dispatcher: blocking })
    t.fail('request should have been refused')
  } catch (err) {
    t.ok(err instanceof errors.AddressBlockedError)
    t.equal(err.address, '::1')
  }
})

test('Should keep validating when the record storage is full instead of failing open', async t => {
  t = tspl(t, { plan: 7 })

  let hits = 0
  const server = await startServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello world!')
  })
  const port = server.address().port

  let lookupCalls = 0
  const agent = new Agent().compose(dns({
    maxItems: 1,
    lookup: (_origin, _opts, cb) => {
      lookupCalls++
      cb(null, [{ address: '127.0.0.1', family: 4 }])
    },
    // Policy: loopback is only allowed for *.example names
    validateAddress: (_address, _family, origin) => origin.hostname.endsWith('.example')
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  // Fill the single storage slot
  const first = await request(`http://one.example:${port}/`, { dispatcher: agent })
  t.equal(first.statusCode, 200)
  await first.body.text()

  // Storage is now full. Previously the interceptor dispatched the ORIGINAL origin
  // unresolved (fail-open — 'localhost' would have been dialed and served). With
  // validateAddress configured it must keep resolving and validating.
  try {
    await request(`http://localhost:${port}/`, { dispatcher: agent })
    t.fail('request should have been refused')
  } catch (err) {
    t.ok(err instanceof errors.AddressBlockedError)
    t.equal(err.hostname, 'localhost')
  }
  t.equal(hits, 1)

  // An allowed host still works while the storage is full: resolved, validated and
  // pinned per dispatch, without being cached.
  const second = await request(`http://two.example:${port}/`, { dispatcher: agent })
  t.equal(second.statusCode, 200)
  await second.body.text()
  const third = await request(`http://two.example:${port}/`, { dispatcher: agent })
  t.equal(third.statusCode, 200)
  await third.body.text()
  // one.example (1) + localhost (1) + two.example (2, uncached because full)
  t.equal(lookupCalls, 4)
})

test('Should re-validate every redirect hop when composed with the redirect interceptor', async t => {
  t = tspl(t, { plan: 4 })

  const paths = []
  const server = await startServer((req, res) => {
    paths.push(req.url)
    if (req.url === '/start') {
      res.writeHead(302, { location: `http://internal.example:${server.address().port}/secret` })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('leaked')
    }
  })
  const port = server.address().port

  const agent = new Agent().compose([
    dns({
      lookup: localLookup(),
      validateAddress: (_address, _family, origin) => origin.hostname !== 'internal.example'
    }),
    interceptors.redirect({ maxRedirections: 2 })
  ])

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  try {
    await request(`http://app.example:${port}/start`, { dispatcher: agent })
    t.fail('redirect hop should have been refused')
  } catch (err) {
    t.ok(err instanceof errors.AddressBlockedError)
    t.equal(err.hostname, 'internal.example')
  }

  // Only the first hop reached the server — the redirect target was refused
  t.deepStrictEqual(paths, ['/start'])
  t.ok(true)
})

test('Should surface the refusal through fetch as the error cause', async t => {
  t = tspl(t, { plan: 2 })

  const server = await startServer((_req, res) => res.end('nope'))
  const port = server.address().port

  const agent = new Agent().compose(dns({
    lookup: localLookup(),
    validateAddress: () => false
  }))

  after(async () => {
    await agent.close()
    await closeServer(server)()
  })

  try {
    await fetch(`http://blocked.example:${port}/`, { dispatcher: agent })
    t.fail('fetch should have been refused')
  } catch (err) {
    t.equal(err.name, 'TypeError')
    t.equal(err.cause?.code, 'UND_ERR_ADDRESS_BLOCKED')
  }
})
