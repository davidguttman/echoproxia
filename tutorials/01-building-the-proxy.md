# Tutorial: Building the Core Echoproxia Proxy Logic

This tutorial guides you through building the core recording and replay functionality of Echoproxia as described in the `README.md`. We'll build an Express middleware that can dynamically switch between recording live interactions and replaying saved ones.

## Prerequisites

*   Node.js installed
*   Basic understanding of Node.js, Express, and HTTP concepts.

## 1. Project Setup

First, let's set up a basic Node.js project and install dependencies.

```bash
mkdir echoproxia-core-tutorial
cd echoproxia-core-tutorial
npm init -y
# Install express and the proxy middleware
npm install express http-proxy-middleware get-port
touch server.js
```

## 2. Basic Express Server

Create a simple Express server in `server.js`.

```javascript
// server.js
const express = require('express')

const app = express()
const port = 3000 // Or dynamically find an available port

// Placeholder for our proxy logic
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.url}`)
  // We'll add proxy logic here
  res.status(501).send('Proxy logic not implemented yet.')
})

app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
```

## 3. State Management

Our proxy needs to maintain some state:

*   `recordMode`: Whether we are recording or replaying.
*   `targetUrl`: The URL to proxy to in record mode.
*   `recordingsDir`: The base directory for saving recordings.
*   `currentSequenceName`: The name of the active test sequence.
*   `replayCounters`: To track the next response index during replay.

Let's add these to our `server.js`. We'll also require the necessary modules, including `fs/promises` for asynchronous file operations and `http-proxy-middleware`.

```javascript
// server.js
const express = require('express')
const path = require('path')
// Use fs/promises for async file operations
const fs = require('fs').promises
const { createProxyMiddleware } = require('http-proxy-middleware')
const zlib = require('zlib') // For handling gzip/deflate
const getPort = require('get-port') // For finding an available port

// --- State ---
let recordMode = true // Default to recording
let targetUrl = 'https://httpbin.org' // Example target
let recordingsDir = path.join(__dirname, '__recordings__')
let currentSequenceName = 'default-sequence'
const replayCounters = {} // Stores { sequenceName: { filePath: index } }
// --- End State ---

const app = express()
const port = 3000

// --- Helper Functions ---
function sanitizeFilename (filePath) {
  // Replace slashes and invalid chars; ensure it starts with '_'
  return `_${filePath.replace(/^\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`
}

// Headers to redact by default
const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie']

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
    // If file doesn't exist or is invalid JSON, return empty array
    if (err.code === 'ENOENT') {
      return []
    }
    console.error(`Error reading or parsing recording file ${filePath}:`, err)
    return [] // Treat errors as empty recordings
  }
}

async function writeRecording (filePath, recording) {
  const sequencePath = path.dirname(filePath)
  try {
    // Ensure directory exists (using fs.promises)
    await fs.mkdir(sequencePath, { recursive: true })

    // Read existing, append, and write back
    const recordings = await readRecordings(filePath)
    recordings.push(recording)
    await fs.writeFile(filePath, JSON.stringify(recordings, null, 2))
    console.log(`Recorded interaction to ${filePath}`)
  } catch (error) {
    console.error(`Error writing recording to ${filePath}:`, error)
    // Decide how to handle write errors - maybe rethrow?
  }
}

// --- End Helper Functions ---

// --- Middleware ---

// Capture raw body BEFORE proxying or replaying
// We need the raw body buffer for accurate recording/replaying
app.use(express.raw({ type: '*/*', limit: '50mb' })) // Handle all content types

// Endpoint to change the sequence
app.post('/echoproxia/sequence/:name', express.json(), (req, res) => { // Use json parser for this route
  currentSequenceName = req.params.name
  console.log(`Sequence set to: ${currentSequenceName}`)
  if (!replayCounters[currentSequenceName]) {
    replayCounters[currentSequenceName] = {}
  }
  res.status(200).send(`Sequence set to ${currentSequenceName}`)
})

// Main Replay/Record Logic Middleware
app.use(async (req, res, next) => {
  // Ignore requests to our internal control endpoint
  if (req.path.startsWith('/echoproxia/')) {
    return next()
  }

  const recordingFilename = sanitizeFilename(req.path)
  const recordingFilepath = path.join(recordingsDir, currentSequenceName, recordingFilename)

  console.log(`Proxy handling: ${req.method} ${req.path} | Mode: ${recordMode ? 'Record' : 'Replay'} | Sequence: ${currentSequenceName}`)

  if (!recordMode) {
    // Replay Mode: Attempt to handle replay directly
    const replayed = await handleReplay(req, res, { recordingFilepath })
    // If handleReplay sent a response, we're done.
    // If it returned false, it means no recording was found or sequence exhausted,
    // and it already sent the 500 error.
    if (replayed || res.headersSent) {
      return // Stop processing
    }
    // If we reach here in replay mode, something unexpected happened
    // (handleReplay should ideally always send *something* or return true)
    console.error('Reached end of middleware in replay mode unexpectedly.')
    if (!res.headersSent) {
       return res.status(500).send('Internal Replay Error.')
    }
    return
  } else {
    // Record Mode: Pass to the proxy middleware configured below
    // We'll add recording logic in the proxy event handlers
    next()
  }
})

// --- Proxy Middleware (Only runs in Record Mode due to logic above) ---
const proxyMiddleware = createProxyMiddleware({
  target: targetUrl,
  changeOrigin: true, // Recommended for most scenarios
  selfHandleResponse: true, // We need to capture the response body
  logLevel: 'silent', // Prevent http-proxy-middleware logs interfering
  onProxyReq: (proxyReq, req, res) => {
    // Add request body if present (captured by express.raw)
    if (req.body && req.body.length > 0) {
      proxyReq.setHeader('Content-Length', Buffer.byteLength(req.body))
      proxyReq.write(req.body)
    }
    proxyReq.end()
  },
  onProxyRes: (proxyRes, req, res) => {
    // Capture response body
    let responseBody = []
    proxyRes.on('data', (chunk) => {
      responseBody.push(chunk)
    })

    proxyRes.on('end', async () => {
      const completeBodyBuffer = Buffer.concat(responseBody)
      const responseStatus = proxyRes.statusCode
      const responseHeaders = proxyRes.headers

      // Handle potential compression (important!)
      let decompressedBodyBuffer = completeBodyBuffer
      const contentEncoding = responseHeaders['content-encoding']
      const originalContentEncoding = Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding // Store original encoding

      try {
         if (contentEncoding === 'gzip') {
           decompressedBodyBuffer = zlib.gunzipSync(completeBodyBuffer)
         } else if (contentEncoding === 'deflate') {
           decompressedBodyBuffer = zlib.inflateSync(completeBodyBuffer)
         }
         // Remove content-encoding header as we're sending decompressed data
         // (Alternatively, re-compress before sending to client)
         delete responseHeaders['content-encoding']
         // Adjust content-length if present
         if (responseHeaders['content-length']) {
            responseHeaders['content-length'] = Buffer.byteLength(decompressedBodyBuffer)
         }
      } catch (unzipErr) {
         console.error('Error decompressing response body:', unzipErr)
         // Decide how to handle: send original compressed body or error?
         // Sending original might be safer if client expects compressed.
         decompressedBodyBuffer = completeBodyBuffer
      }

      // --- Determine Body Storage Format ---
      let bodyStorage
      try {
        // Attempt to decode as UTF-8
        const utf8String = decompressedBodyBuffer.toString('utf8')
        // Basic check: Does re-encoding match? (More sophisticated checks could be added)
        if (Buffer.compare(Buffer.from(utf8String, 'utf8'), decompressedBodyBuffer) === 0) {
          bodyStorage = {
            encoding: 'utf8',
            data: utf8String
          }
        } else {
          throw new Error('Not safely decodable as UTF-8 string for storage.')
        }
      } catch (e) {
        // Fallback to Base64 for binary data or strings unsafe for JSON
        bodyStorage = {
          encoding: 'base64',
          data: decompressedBodyBuffer.toString('base64')
        }
      }

      // --- Recording Logic ---
      const recordingFilename = sanitizeFilename(req.path)
      const recordingFilepath = path.join(recordingsDir, currentSequenceName, recordingFilename)

      const recordedRequest = {
        method: req.method,
        path: req.path,
        // req.originalUrl includes query params
        originalUrl: req.originalUrl,
        headers: redactHeaders(req.headers, DEFAULT_REDACT_HEADERS),
        // Store raw body as base64
        body: req.body instanceof Buffer ? req.body.toString('base64') : null
      }

      const recordedResponse = {
        status: responseStatus,
        headers: redactHeaders(responseHeaders, DEFAULT_REDACT_HEADERS),
        // Store body using determined format + original encoding info
        body: {
          ...bodyStorage,
          originalContentEncoding: originalContentEncoding || null // Store explicitly as null if undefined
        }
      }

      // Asynchronously write the recording
      await writeRecording(recordingFilepath, { request: recordedRequest, response: recordedResponse })
      // --- End Recording Logic ---

      // --- Send response to client ---
      res.writeHead(responseStatus, responseHeaders)
      res.end(decompressedBodyBuffer) // Send the (potentially decompressed) body
    })

    proxyRes.on('error', (error, req, res) => {
       console.error('Proxy Response Error:', error);
       if (!res.headersSent) {
           res.writeHead(500, { 'Content-Type': 'text/plain' });
       }
       res.end('Proxy response error: ' + error.message);
    })
  },
  onError: (err, req, res) => {
     console.error('Proxy Error:', err);
     if (!res.headersSent) {
       res.writeHead(502, { 'Content-Type': 'text/plain' });
     }
     res.end('Proxy error: ' + err.message);
  }
})

// Apply the proxy middleware *after* the record/replay decider
app.use((req, res, next) => {
  // Only proxy if in record mode (double check)
  if (recordMode && !req.path.startsWith('/echoproxia/')) {
    proxyMiddleware(req, res, next)
  } else {
    // If not record mode or it's an internal path, do nothing here
    // (replay handled earlier, internal handled by specific routes)
    next()
  }
})

// --- Server Start Function (modified for testing) ---
let runningServer = null

async function startServer () {
  const actualPort = await getPort({ port: getPort.makeRange(3000, 3100) }) // Find port in range 3000-3100
  return new Promise((resolve) => {
    runningServer = app.listen(actualPort, () => {
      console.log(`Server listening on port ${actualPort}`)
      console.log(`Recordings will be saved to: ${recordingsDir}`)
      resolve({ server: runningServer, port: actualPort, url: `http://localhost:${actualPort}` })
    })
  })
}

async function stopServer () {
  if (runningServer) {
    return new Promise((resolve) => {
      runningServer.close(() => {
        console.log('Server stopped')
        runningServer = null
        resolve()
      })
    })
  } else {
    return Promise.resolve()
  }
}

// Only start server automatically if run directly
if (require.main === module) {
  startServer()
}

// --- Replay Function (Modified) ---
async function handleReplay (req, res, { recordingFilepath }) {
  // 1. Read recordings using async helper
  const recordings = await readRecordings(recordingFilepath)

  if (recordings.length === 0) {
     console.warn(`Replay warning: Recording file not found or empty: ${recordingFilepath}`)
     res.status(500).send(`Echoproxia Replay Error: No recording found for path ${req.path} in sequence ${currentSequenceName}.`)
     return false // Indicate failure (already sent response)
  }

  // 2. Get current index
  if (!replayCounters[currentSequenceName]) {
    replayCounters[currentSequenceName] = {} // Ensure sequence obj exists
  }
  const sequenceReplayState = replayCounters[currentSequenceName]
  const currentIndex = sequenceReplayState[recordingFilepath] || 0 // Default to 0

  // 3. Check bounds
  if (currentIndex >= recordings.length) {
    console.warn(`Replay warning: Sequence exhausted for ${recordingFilepath}`)
    res.status(500).send(`Echoproxia Replay Error: Sequence exhausted for path ${req.path} in sequence ${currentSequenceName}.`)
    return false // Indicate failure (already sent response)
  }

  // 4. Retrieve recorded response
  const { response: recordedResponse } = recordings[currentIndex]

  // 5. Reconstruct body from stored format
  let responseBodyBuffer
  if (recordedResponse.body.encoding === 'base64') {
    responseBodyBuffer = Buffer.from(recordedResponse.body.data, 'base64')
  } else { // Assumed utf8
    responseBodyBuffer = Buffer.from(recordedResponse.body.data, 'utf8')
  }

  // 5. Increment index for next time
  sequenceReplayState[recordingFilepath] = currentIndex + 1

  // 6. Re-compress if necessary
  const targetContentEncoding = recordedResponse.body.originalContentEncoding
  let finalBodyBuffer = responseBodyBuffer
  if (targetContentEncoding === 'gzip') {
    finalBodyBuffer = zlib.gzipSync(responseBodyBuffer)
  } else if (targetContentEncoding === 'deflate') {
    finalBodyBuffer = zlib.deflateSync(responseBodyBuffer)
  }

  // 7. Send recorded response
  res.status(recordedResponse.status)
  // Set headers, ensuring complex values are handled (e.g., arrays for set-cookie)
  Object.entries(recordedResponse.headers).forEach(([key, value]) => {
     try {
       res.setHeader(key, value)
     } catch (headerErr) {
        console.warn(`Could not set header ${key}: ${value} - ${headerErr.message}`)
     }
  })
  // Restore original Content-Encoding and set Content-Length for the final buffer
  if (targetContentEncoding) {
     res.setHeader('content-encoding', targetContentEncoding)
  }
  // Remove potentially incorrect content-length from saved headers and set the correct one
  res.removeHeader('content-length')
  res.setHeader('content-length', Buffer.byteLength(finalBodyBuffer))

  // Make sure transfer-encoding is not conflicting (Express might add it)
  res.removeHeader('transfer-encoding')

  res.send(finalBodyBuffer) // Send the final (potentially re-compressed) buffer
  console.log(`Replayed interaction from ${recordingFilepath} at index ${currentIndex}`)
  return true // Indicate success
}

module.exports = { // Export functions needed for testing
  startServer,
  stopServer,
  setMode: (mode) => { recordMode = mode },
  setTargetUrl: (url) => { targetUrl = url },
  setRecordingsDir: (dir) => { recordingsDir = dir },
  // Expose state for assertion (use with caution in real apps)
  getState: () => ({ recordMode, targetUrl, recordingsDir, currentSequenceName })
} 