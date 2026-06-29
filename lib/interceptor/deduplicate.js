'use strict'

const diagnosticsChannel = require('node:diagnostics_channel')
const util = require('../core/util')
const DeduplicationHandler = require('../handler/deduplication-handler')
const { normalizeHeaders, makeCacheKey, makeDeduplicationKey, isCacheableRequestBody, isStreamingRequestBody, readRequestBodyForKey, bodySignificantMethods, DEFAULT_MAX_REQUEST_BODY_KEY_SIZE } = require('../util/cache.js')

const pendingRequestsChannel = diagnosticsChannel.channel('undici:request:pending-requests')

/**
 * @param {import('../../types/interceptors.d.ts').default.DeduplicateInterceptorOpts} [opts]
 * @returns {import('../../types/dispatcher.d.ts').default.DispatcherComposeInterceptor}
 */
module.exports = (opts = {}) => {
  const {
    methods = ['GET'],
    skipHeaderNames = [],
    excludeHeaderNames = [],
    maxBufferSize = 5 * 1024 * 1024,
    maxRequestBodyKeySize = DEFAULT_MAX_REQUEST_BODY_KEY_SIZE
  } = opts

  if (typeof opts !== 'object' || opts === null) {
    throw new TypeError(`expected type of opts to be an Object, got ${opts === null ? 'null' : typeof opts}`)
  }

  if (!Array.isArray(methods)) {
    throw new TypeError(`expected opts.methods to be an array, got ${typeof methods}`)
  }

  for (const method of methods) {
    if (!util.safeHTTPMethods.includes(method)) {
      throw new TypeError(`expected opts.methods to only contain safe HTTP methods, got ${method}`)
    }
  }

  if (!Array.isArray(skipHeaderNames)) {
    throw new TypeError(`expected opts.skipHeaderNames to be an array, got ${typeof skipHeaderNames}`)
  }

  if (!Array.isArray(excludeHeaderNames)) {
    throw new TypeError(`expected opts.excludeHeaderNames to be an array, got ${typeof excludeHeaderNames}`)
  }

  if (!Number.isFinite(maxBufferSize) || maxBufferSize <= 0) {
    throw new TypeError(`expected opts.maxBufferSize to be a positive finite number, got ${maxBufferSize}`)
  }

  if (!Number.isInteger(maxRequestBodyKeySize) || maxRequestBodyKeySize < 0) {
    throw new TypeError(`expected opts.maxRequestBodyKeySize to be a non-negative integer, got ${maxRequestBodyKeySize}`)
  }

  // Convert to lowercase Set for case-insensitive header matching
  const skipHeaderNamesSet = new Set(skipHeaderNames.map(name => name.toLowerCase()))

  // Convert to lowercase Set for case-insensitive header exclusion from deduplication key
  const excludeHeaderNamesSet = new Set(excludeHeaderNames.map(name => name.toLowerCase()))

  /**
   * Map of pending requests for deduplication
   * @type {Map<string, DeduplicationHandler>}
   */
  const pendingRequests = new Map()

  return dispatch => {
    // Performs the actual dedup keying/attachment for `opts` (whose body, for
    // QUERY, is now an in-memory Buffer/string).
    const proceedWithDedup = (opts, handler) => {
      opts = {
        ...opts,
        headers: normalizeHeaders(opts)
      }

      // Skip deduplication if request contains any of the specified headers
      if (skipHeaderNamesSet.size > 0) {
        for (const headerName of Object.keys(opts.headers)) {
          if (skipHeaderNamesSet.has(headerName.toLowerCase())) {
            return dispatch(opts, handler)
          }
        }
      }

      const cacheKey = makeCacheKey(opts)
      const dedupeKey = makeDeduplicationKey(cacheKey, excludeHeaderNamesSet)

      // Check if there's already a pending request for this key
      const pendingHandler = pendingRequests.get(dedupeKey)
      if (pendingHandler) {
        // Add this handler to the waiting list when safe.
        // If body streaming has already started, this request must be sent independently.
        if (pendingHandler.addWaitingHandler(handler)) {
          return true
        }

        return dispatch(opts, handler)
      }

      // Create a new deduplication handler
      const deduplicationHandler = new DeduplicationHandler(
        handler,
        () => {
          // Clean up when request completes
          pendingRequests.delete(dedupeKey)
          if (pendingRequestsChannel.hasSubscribers) {
            pendingRequestsChannel.publish({ size: pendingRequests.size, key: dedupeKey, type: 'removed' })
          }
        },
        maxBufferSize
      )

      // Register the pending request
      pendingRequests.set(dedupeKey, deduplicationHandler)
      if (pendingRequestsChannel.hasSubscribers) {
        pendingRequestsChannel.publish({ size: pendingRequests.size, key: dedupeKey, type: 'added' })
      }

      return dispatch(opts, deduplicationHandler)
    }

    return (opts, handler) => {
      if (!opts.origin || methods.includes(opts.method) === false) {
        return dispatch(opts, handler)
      }

      // A body-significant method (QUERY) is identified by its request content
      // (RFC 10008 Section 2.7), so the body must be part of the dedup key.
      if (bodySignificantMethods.has(opts.method)) {
        if (isStreamingRequestBody(opts.body)) {
          // Buffer the stream up to the cap so concurrent same-body QUERYs can
          // be deduplicated without unbounded memory; larger bodies dispatch
          // independently (we cannot prove two unbuffered streams are equal).
          return readRequestBodyForKey(opts.body, maxRequestBodyKeySize).then(prepared => {
            if (prepared.overflow !== undefined) {
              return dispatch({ ...opts, body: prepared.overflow }, handler)
            }
            return proceedWithDedup({ ...opts, body: prepared.buffered }, handler)
          })
        }
        if (!isCacheableRequestBody(opts.body)) {
          return dispatch(opts, handler)
        }
      }

      return proceedWithDedup(opts, handler)
    }
  }
}
