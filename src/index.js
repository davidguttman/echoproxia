// src/index.js - Main module entry point
const express = require('express')
const path = require('path')
const fs = require('fs').promises
const { createProxyMiddleware } = require('http-proxy-middleware')
const zlib = require('zlib')
const getPort = require('get-port')

// --- Helper Functions ---
function sanitizeFilename (filePath) {
  // Replace slashes and invalid chars; ensure it starts with '_'
  return `_${filePath.replace(/^\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`
}

function redactHeaders (headers, headersToRedact) {
  const redacted = {}
  for (const key in headers) {
    if (headersToRedact.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]'
    } else {
      redacted[key] = headers[key]
    }
  }
  return redacted
}

async function readRecordings (filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    const recordings = JSON.parse(data)
    return Array.isArray(recordings) ? recordings : []
  } catch (err) {
    if (err.code === 'ENOENT') {
      return []
    }
    console.error(`Error reading or parsing recording file ${filePath}:`, err)
    return []
  }
}

async function writeRecording (filePath, recording) {
  const sequencePath = path.dirname(filePath)
  try {
    await fs.mkdir(sequencePath, { recursive: true })
    const recordings = await readRecordings(filePath)
    recordings.push(recording)
    await fs.writeFile(filePath, JSON.stringify(recordings, null, 2))
    console.log(`Recorded interaction to ${filePath}`)
  } catch (error) {
    console.error(`Error writing recording to ${filePath}:`, error)
  }
}
// --- End Helper Functions ---

async function createProxy (options = {}) {
  const {
    recordMode = false,
    targetUrl = 'http://localhost', // Need a default or make required
    recordingsDir = path.join(process.cwd(), '__recordings__'),
    defaultSequenceName = 'default-sequence',
    redactHeaders: headersToRedactInput = ['authorization'] // Default redaction
  } = options

  // --- State (scoped within createProxy) ---
  let currentRecordMode = recordMode
  let currentTargetUrl = targetUrl
  let currentRecordingsDir = recordingsDir
  let currentSequenceName = defaultSequenceName
  const replayCounters = {}
  const headersToRedact = headersToRedactInput.map(h => h.toLowerCase())
  let runningServer = null
  // --- End State ---

  const app = express()

  // --- Middleware ---
  app.use(express.raw({ type: '*/*', limit: '50mb' }))

  // --- Control Endpoint --- (Needs modification for internal control)
  // This simple POST might conflict if the target API uses the same path.
  // A more robust solution might involve a dedicated control port or more unique path.
  app.post('/echoproxia/sequence/:name', express.json(), (req, res) => {
    currentSequenceName = req.params.name
    console.log(`[Echoproxia] Sequence set to: ${currentSequenceName}`)
    if (!replayCounters[currentSequenceName]) {
      replayCounters[currentSequenceName] = {}
    }
    res.status(200).send(`Sequence set to ${currentSequenceName}`)
  })

  // --- Replay Function (scoped) ---
  async function handleReplay (req, res, { recordingFilepath }) {
    const sequenceRecordings = await readRecordings(recordingFilepath)
    if (sequenceRecordings.length === 0) {
      console.warn(`[Echoproxia] Replay warning: Recording file not found or empty: ${recordingFilepath}`)
      res.status(500).send(`Echoproxia Replay Error: No recording found for path ${req.path} in sequence ${currentSequenceName}.`)
      return false
    }

    if (!replayCounters[currentSequenceName]) {
      replayCounters[currentSequenceName] = {}
    }
    const sequenceReplayState = replayCounters[currentSequenceName]
    const currentIndex = sequenceReplayState[recordingFilepath] || 0

    if (currentIndex >= sequenceRecordings.length) {
      console.warn(`[Echoproxia] Replay warning: Sequence exhausted for ${recordingFilepath}`)
      res.status(500).send(`Echoproxia Replay Error: Sequence exhausted for path ${req.path} in sequence ${currentSequenceName}.`)
      return false
    }

    const { response: recordedResponse } = sequenceRecordings[currentIndex]
    sequenceReplayState[recordingFilepath] = currentIndex + 1

    let responseBodyBuffer
    if (recordedResponse.body.encoding === 'base64') {
      responseBodyBuffer = Buffer.from(recordedResponse.body.data, 'base64')
    } else {
      responseBodyBuffer = Buffer.from(recordedResponse.body.data, 'utf8')
    }

    const targetContentEncoding = recordedResponse.body.originalContentEncoding
    let finalBodyBuffer = responseBodyBuffer
    if (targetContentEncoding === 'gzip') {
      finalBodyBuffer = zlib.gzipSync(responseBodyBuffer)
    } else if (targetContentEncoding === 'deflate') {
      finalBodyBuffer = zlib.deflateSync(responseBodyBuffer)
    }

    res.status(recordedResponse.status)
    Object.entries(recordedResponse.headers).forEach(([key, value]) => {
      try {
        res.setHeader(key, value)
      } catch (headerErr) {
        console.warn(`[Echoproxia] Could not set header ${key}: ${value} - ${headerErr.message}`)
      }
    })

    if (targetContentEncoding) {
      res.setHeader('content-encoding', targetContentEncoding)
    }
    res.removeHeader('content-length')
    res.setHeader('content-length', Buffer.byteLength(finalBodyBuffer))
    res.removeHeader('transfer-encoding')

    res.send(finalBodyBuffer)
    console.log(`[Echoproxia] Replayed interaction from ${recordingFilepath} at index ${currentIndex}`)
    return true
  }

  // --- Proxy Middleware Setup ---
  // We defer creating the actual middleware instance until a request comes in record mode,
  // to ensure it captures the currentTargetUrl correctly.
  // const proxyMiddlewareInstance = createProxyMiddleware({ ... })

  // --- Main Request Handling Middleware ---
  app.use(async (req, res, next) => {
    // Ignore internal control path
    if (req.path.startsWith('/echoproxia/')) {
      return next()
    }

    const recordingFilename = sanitizeFilename(req.path)
    const recordingFilepath = path.join(currentRecordingsDir, currentSequenceName, recordingFilename)

    if (!currentRecordMode) {
      // Replay Mode
      const replayed = await handleReplay(req, res, { recordingFilepath })
      if (!replayed && !res.headersSent) {
        // handleReplay already sent 500, but if somehow it didn't...
        console.error('[Echoproxia] Replay failed unexpectedly without sending response.')
        res.status(500).send('Internal Echoproxia Replay Error.')
      }
      // Don't call next() in replay mode, response is handled or error sent
    } else {
      // Record Mode - Create and call the proxy middleware instance
      const proxyMiddlewareInstance = createProxyMiddleware({
        target: currentTargetUrl, // Use the current URL directly
        changeOrigin: true,
        selfHandleResponse: true,
        logLevel: 'silent',
        onProxyReq: (proxyReq, req, res) => {
          // Add request body if present
          if (req.body && req.body.length > 0) {
            proxyReq.setHeader('Content-Length', Buffer.byteLength(req.body))
            proxyReq.write(req.body)
          }
          proxyReq.end()
        },
        onProxyRes: (proxyRes, req, res) => {
          let responseBodyChunks = []
          proxyRes.on('data', (chunk) => {
            responseBodyChunks.push(chunk)
          })
          proxyRes.on('end', async () => {
            const completeBodyBuffer = Buffer.concat(responseBodyChunks)
            const responseStatus = proxyRes.statusCode
            const responseHeaders = { ...proxyRes.headers } // Clone headers

            let decompressedBodyBuffer = completeBodyBuffer
            const contentEncoding = responseHeaders['content-encoding']
            const originalContentEncoding = Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding

            try {
              if (contentEncoding === 'gzip') {
                decompressedBodyBuffer = zlib.gunzipSync(completeBodyBuffer)
              } else if (contentEncoding === 'deflate') {
                decompressedBodyBuffer = zlib.inflateSync(completeBodyBuffer)
              }
            } catch (unzipErr) {
              console.error('[Echoproxia] Error decompressing response body:', unzipErr)
              decompressedBodyBuffer = completeBodyBuffer // Use original if decompression fails
            }

            let bodyStorage
            try {
              const utf8String = decompressedBodyBuffer.toString('utf8')
              if (Buffer.compare(Buffer.from(utf8String, 'utf8'), decompressedBodyBuffer) === 0) {
                bodyStorage = { encoding: 'utf8', data: utf8String }
              } else {
                throw new Error('Not safely decodable as UTF-8 string')
              }
            } catch (e) {
              bodyStorage = { encoding: 'base64', data: decompressedBodyBuffer.toString('base64') }
            }

            const recordingFilename = sanitizeFilename(req.path)
            const recordingFilepath = path.join(currentRecordingsDir, currentSequenceName, recordingFilename)

            const recordedRequest = {
              method: req.method,
              path: req.path,
              originalUrl: req.originalUrl,
              headers: redactHeaders(req.headers, headersToRedact),
              body: req.body instanceof Buffer ? req.body.toString('base64') : null
            }

            const recordedResponse = {
              status: responseStatus,
              headers: redactHeaders({ ...responseHeaders }, headersToRedact), // Redact cloned headers
              body: {
                ...bodyStorage,
                originalContentEncoding: originalContentEncoding || null
              }
            }

            // Write recording asynchronously (don't wait)
            writeRecording(recordingFilepath, { request: recordedRequest, response: recordedResponse })

            // Send response back to client (using original headers and potentially decompressed body)
            // Important: Use original headers before redaction/deletion for sending back
            delete responseHeaders['content-encoding'] // Client shouldn't receive encoding if we decompressed
            if (responseHeaders['content-length']) {
               responseHeaders['content-length'] = Buffer.byteLength(decompressedBodyBuffer)
            }
            res.writeHead(responseStatus, responseHeaders)
            res.end(decompressedBodyBuffer)
          })
          proxyRes.on('error', (error, req, res) => {
            console.error('[Echoproxia] Proxy Response Error:', error);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end('Proxy response error: ' + error.message);
          })
        },
        onError: (err, req, res) => {
          console.error('[Echoproxia] Proxy Error:', err);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          res.end('Proxy error: ' + err.message);
        }
      })
      // Now call the created middleware instance
      proxyMiddlewareInstance(req, res, next)
    }
  })

  // --- Start Server ---
  const actualPort = await getPort({ port: options.port || getPort.makeRange(5000, 5100) })
  return new Promise((resolve, reject) => {
    try {
      runningServer = app.listen(actualPort, () => {
        console.log(`[Echoproxia] Server listening on port ${actualPort}`)
        console.log(`[Echoproxia] Mode: ${currentRecordMode ? 'Record' : 'Replay'}, Target: ${currentTargetUrl}, Recordings: ${currentRecordingsDir}`)

        // --- Return Control Object ---
        resolve({
          port: actualPort,
          url: `http://localhost:${actualPort}`,
          server: runningServer,
          setSequence: (sequenceName) => {
            currentSequenceName = sequenceName
            console.log(`[Echoproxia] Sequence set to: ${currentSequenceName}`)
            if (!replayCounters[currentSequenceName]) {
              replayCounters[currentSequenceName] = {}
            }
          },
          // Add setMode, setTargetUrl etc. if needed for runtime changes
          stop: async () => {
            return new Promise((resolveStop, rejectStop) => {
              if (runningServer) {
                runningServer.close((err) => {
                  if (err) return rejectStop(err)
                  console.log('[Echoproxia] Server stopped')
                  runningServer = null
                  resolveStop()
                })
              } else {
                resolveStop()
              }
            })
          }
        })
      })

      runningServer.on('error', (err) => {
        console.error('[Echoproxia] Server error:', err)
        reject(err)
      })

    } catch (err) {
       console.error('[Echoproxia] Failed to start server:', err)
       reject(err)
    }

  })
}

module.exports = { createProxy } 