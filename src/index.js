// src/index.js - Main module entry point
const express = require('express')
const path = require('path')
const fs = require('fs').promises
const { createProxyMiddleware } = require('http-proxy-middleware')
const zlib = require('zlib')
const getPort = require('get-port')
const debug = require('debug')

const logInfo = debug('echoproxia:info')
const logWarn = debug('echoproxia:warn')
const logError = debug('echoproxia:error')

// --- Helper Functions ---
function sanitizeFilename (filePath) {
  // Replace slashes and invalid chars; ensure it starts with '_'
  const baseName = `_${filePath.replace(/^\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  // Append the specific extension
  return `${baseName}.echo.json`;
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
    logError(`Error reading or parsing recording file ${filePath}:`, err)
    return []
  }
}

async function writeRecording (filePath, recording) {
  const sequencePath = path.dirname(filePath); // e.g., __recordings__/my-test
  try {
    // Ensure the base directory for the sequence exists
    await fs.mkdir(sequencePath, { recursive: true });

    // Create a new array containing only the current recording
    const recordings = [recording];
    // filePath will now end in .echo.json due to sanitizeFilename change
    await fs.writeFile(filePath, JSON.stringify(recordings, null, 2));
    // Updated log message slightly
    logInfo(`Recorded interaction to ${filePath} (new file)`);
  } catch (error) {
    logError(`Error writing recording to ${filePath}:`, error);
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

  // --- Initial Sequence Directory Cleanup (if in record mode) ---
  // Updated to only delete .echo.json files
  if (currentRecordMode) {
    const initialSequencePath = path.join(currentRecordingsDir, currentSequenceName);
    logInfo(`Record mode active: Clearing initial *.echo.json files in: ${initialSequencePath}`);
    // Use an async IIFE for non-blocking cleanup
    (async () => {
      try {
        const filenames = await fs.readdir(initialSequencePath);
        for (const filename of filenames) {
          if (filename.endsWith('.echo.json')) { // TARGETED DELETION
            const filePath = path.join(initialSequencePath, filename);
            try {
              await fs.unlink(filePath);
              logInfo(`Deleted initial recording file: ${filePath}`);
            } catch (unlinkErr) {
              logError(`Error deleting initial file ${filePath}:`, unlinkErr);
            }
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') { // Ignore if dir doesn't exist
           logError(`Error reading initial directory ${initialSequencePath} for cleanup:`, err);
        } else {
           logInfo(`Initial sequence directory ${initialSequencePath} does not exist, nothing to clear.`);
        }
      }
    })(); // Fire-and-forget
  }
  // --- End Initial Cleanup ---

  const app = express()

  // --- Middleware ---
  app.use(express.raw({ type: '*/*', limit: '50mb' }))

  // --- Control Endpoint --- (Needs modification for internal control)
  // This simple POST might conflict if the target API uses the same path.
  // A more robust solution might involve a dedicated control port or more unique path.
  app.post('/echoproxia/sequence/:name', express.json(), (req, res) => {
    currentSequenceName = req.params.name
    logInfo(`Sequence set to: ${currentSequenceName}`)
    if (!replayCounters[currentSequenceName]) {
      replayCounters[currentSequenceName] = {}
    }
    res.status(200).send(`Sequence set to ${currentSequenceName}`)
  })

  // --- Replay Function (scoped) ---
  // Updated for backwards compatibility reading .json files
  async function handleReplay (req, res, /* { other params } */ ) {
    // 1. Construct NEW filename (.echo.json)
    const recordingFilenameNew = sanitizeFilename(req.path); // Uses new .echo.json convention
    const recordingFilepathNew = path.join(currentRecordingsDir, currentSequenceName, recordingFilenameNew);

    // 2. Construct OLD filename (.json)
    // Corrected the regex to properly escape dots
    const recordingFilenameOld = recordingFilenameNew.replace(/\.echo\.json$/, '.json');
    const recordingFilepathOld = path.join(currentRecordingsDir, currentSequenceName, recordingFilenameOld);

    let sequenceRecordings = [];
    let usedFilepath = ''; // Track which file was actually used

    // 3. Attempt to read NEW format first
    try {
      logInfo(`Replay: Attempting to read new format: ${recordingFilepathNew}`);
      sequenceRecordings = await readRecordings(recordingFilepathNew);
      if (sequenceRecordings.length > 0) {
         usedFilepath = recordingFilepathNew;
         logInfo(`Replay: Using new format file: ${usedFilepath}`);
      }
    } catch (err) { /* Ignore read errors for now */ }

    // 4. If NEW format is empty/missing, attempt to read OLD format
    if (sequenceRecordings.length === 0) {
      try {
        logInfo(`Replay: New format not found/empty, trying old format: ${recordingFilepathOld}`);
        sequenceRecordings = await readRecordings(recordingFilepathOld);
        if (sequenceRecordings.length > 0) {
           usedFilepath = recordingFilepathOld;
           logInfo(`Replay: Using old format file (backwards compat): ${usedFilepath}`);
        }
      } catch (err) { /* Ignore read errors */ }
    }

    // 5. Check if any recordings were found
    if (sequenceRecordings.length === 0) {
      logWarn(`Replay warning: No recording file found or empty for path ${req.path} (checked ${recordingFilenameNew} and ${recordingFilenameOld})`);
      res.status(500).send(`Echoproxia Replay Error: No recording found for path ${req.path} in sequence ${currentSequenceName}.`);
      return false; // Indicate failure
    }

    // --- REMAINDER of handleReplay logic ---
    // Use sequenceRecordings and usedFilepath for replay counter logic and serving response
    if (!replayCounters[currentSequenceName]) {
       replayCounters[currentSequenceName] = {};
    }
    // IMPORTANT: Use usedFilepath for the replay counter key!
    const sequenceReplayState = replayCounters[currentSequenceName];
    const currentIndex = sequenceReplayState[usedFilepath] || 0; // Keyed by actual file used

    if (currentIndex >= sequenceRecordings.length) {
       logWarn(`Replay warning: Sequence exhausted for ${usedFilepath}`);
       res.status(500).send(`Echoproxia Replay Error: Sequence exhausted for path ${req.path} in sequence ${currentSequenceName} (file: ${usedFilepath}).`);
       return false;
    }

    const { response: recordedResponse } = sequenceRecordings[currentIndex];
    // IMPORTANT: Update counter using usedFilepath
    sequenceReplayState[usedFilepath] = currentIndex + 1;

    // --- Streaming Replay Refactor --- (Keep existing streaming logic)
    if (!recordedResponse.chunks || !Array.isArray(recordedResponse.chunks)) {
      logError(`Replay Error: Recording at index ${currentIndex} for ${usedFilepath} is missing or has invalid 'chunks' format.`);
      res.status(500).send(`Echoproxia Replay Error: Invalid recording format for path ${req.path} in sequence ${currentSequenceName}.`);
      return false; // Indicate failure
    }

    // 1. Send Headers
    res.status(recordedResponse.status);
    Object.entries(recordedResponse.headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'content-length' && lowerKey !== 'transfer-encoding') {
          try {
              res.setHeader(key, value);
          } catch (headerErr) {
              logWarn(`Could not set header during replay ${key}: ${value} - ${headerErr.message}`);
          }
      }
    });
    res.writeHead(recordedResponse.status);

    // 2. Stream Chunks
    for (const base64Chunk of recordedResponse.chunks) {
      try {
        const chunkBuffer = Buffer.from(base64Chunk, 'base64');
        res.write(chunkBuffer);
      } catch (decodeErr) {
        logError(`Replay Error: Failed to decode base64 chunk at index ${currentIndex} for ${usedFilepath}: ${decodeErr.message}`);
        res.end();
        return false;
      }
    }

    // 3. End Stream
    res.end();

    logInfo(`Replayed interaction ${currentIndex + 1}/${sequenceRecordings.length} from ${usedFilepath}`);
    return true; // Indicate success
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

    // Note: handleReplay now internally determines the correct file path (.echo.json or .json)
    // We don't need to pass recordingFilepath directly anymore if handleReplay is self-contained
    // const recordingFilename = sanitizeFilename(req.path);
    // const recordingFilepath = path.join(currentRecordingsDir, currentSequenceName, recordingFilename);

    if (!currentRecordMode) {
      // Replay Mode
      // Pass necessary context, handleReplay finds the file
      const replayed = await handleReplay(req, res, { /* other context if needed */ })
      if (!replayed && !res.headersSent) {
        logError('Replay failed unexpectedly without sending response.')
        res.status(500).send('Internal Echoproxia Replay Error.')
      }
      // Don't call next()
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
          // --- Streaming Refactor ---
          // Immediately forward headers from the target response to the client
          Object.keys(proxyRes.headers).forEach((key) => {
            // Some headers (like transfer-encoding) might cause issues if blindly copied.
            // We might need more sophisticated filtering later.
            res.setHeader(key, proxyRes.headers[key]);
          });
          res.writeHead(proxyRes.statusCode);

          const recordedChunks = []; // Array to store chunks for recording
          let completeBodyForLogging = Buffer.alloc(0) // Still buffer for potential non-stream logging/debugging if needed later

          proxyRes.on('data', (chunk) => {
            // 1. Send the chunk immediately to the client
            res.write(chunk);
            // 2. Capture the chunk for recording
            recordedChunks.push(chunk.toString('base64')); // Store as base64
            // 3. (Optional) Append to complete buffer if needed elsewhere
            completeBodyForLogging = Buffer.concat([completeBodyForLogging, chunk])
          });

          proxyRes.on('end', async () => {
            // 1. Signal the end of the response stream to the client
            res.end();

            // 2. Now, process and save the recording with the captured chunks
            const responseStatus = proxyRes.statusCode;
            // Clone original headers for recording, BEFORE potential manipulation
            const headersForRecording = redactHeaders({ ...proxyRes.headers }, headersToRedact);

            const recordingFilename = sanitizeFilename(req.path);
            const recordingFilepath = path.join(currentRecordingsDir, currentSequenceName, recordingFilename);

            const recordedRequest = {
              method: req.method,
              path: req.path,
              originalUrl: req.originalUrl,
              headers: redactHeaders(req.headers, headersToRedact),
              // Ensure request body is stored appropriately (assuming it wasn't streamed)
              body: req.body instanceof Buffer ? req.body.toString('base64') : (typeof req.body === 'string' ? req.body : null)
            };

            // New structure for recorded response, storing chunks
            const recordedResponse = {
              status: responseStatus,
              headers: headersForRecording,
              body: null, // Remove old single body structure
              chunks: recordedChunks // Store the array of base64 chunks
            };

            logInfo(`Recording ${recordedChunks.length} chunks for ${req.path} to ${recordingFilename}`) // Log new filename
            writeRecording(recordingFilepath, { request: recordedRequest, response: recordedResponse });

            // Logging/Debug output (optional)
            const logBody = completeBodyForLogging.toString('utf8').substring(0, 100) // Log first 100 chars
            logInfo(`Finished proxying and recording for ${req.path}. Status: ${responseStatus}. Chunks: ${recordedChunks.length}. Start of body: ${logBody}...`)
          });

          proxyRes.on('error', (err) => {
            logError(`Error receiving response from target for ${req.path}: ${err.message}`);
            if (!res.headersSent) {
              res.status(502).send('Proxy error: Upstream connection error');
            } else {
              // If headers already sent, we might need to signal error differently
              res.end(); // End the response abruptly
            }
          });
        },
        onError: (err, req, res) => {
          logError('Proxy Error:', err);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          res.end('Proxy error: ' + err.message);
        }
      })
      proxyMiddlewareInstance(req, res, next)
    }
  })

  // --- Start Server ---
  const actualPort = await getPort({ port: options.port || getPort.makeRange(5000, 5100) })
  return new Promise((resolve, reject) => {
    try {
      runningServer = app.listen(actualPort, () => {
        logInfo(`Server listening on port ${actualPort}`)
        logInfo(`Mode: ${currentRecordMode ? 'Record' : 'Replay'}, Target: ${currentTargetUrl}, Recordings: ${currentRecordingsDir}`)

        // --- Return Control Object ---
        resolve({
          port: actualPort,
          url: `http://localhost:${actualPort}`,
          server: runningServer,
          setSequence: async (sequenceName) => { // Keep async
            // --- Sequence Recording Cleanup Logic --- (Uses currentRecordMode for now)
            // This logic will be updated in the next tutorial (03) for overrides
            const effectiveMode = currentRecordMode; // Placeholder for now

            if (effectiveMode === true) { // Only clear if effective mode is record
              const sequencePath = path.join(currentRecordingsDir, sequenceName);
              logInfo(`Effective mode is 'record': Clearing *.echo.json files in: ${sequencePath}`);
              try {
                const filenames = await fs.readdir(sequencePath);
                for (const filename of filenames) {
                  // --- TARGETED DELETION ---
                  if (filename.endsWith('.echo.json')) {
                    const filePath = path.join(sequencePath, filename);
                    try {
                      await fs.unlink(filePath);
                      logInfo(`Deleted recording file: ${filePath}`);
                    } catch (unlinkErr) {
                       logError(`Error deleting file ${filePath}:`, unlinkErr);
                    }
                  }
                }
              } catch (err) {
                if (err.code === 'ENOENT') {
                  logInfo(`Sequence directory ${sequencePath} does not exist, nothing to clear.`);
                } else {
                  logError(`Error reading sequence directory ${sequencePath} for cleanup:`, err);
                }
              }
            }
            // --- End Cleanup Logic ---

            currentSequenceName = sequenceName
            logInfo(`Sequence set to: ${currentSequenceName}`)
            replayCounters[currentSequenceName] = {} // Reset replay state
          },
          // Add setMode, setTargetUrl etc. if needed for runtime changes
          stop: async () => {
            return new Promise((resolveStop, rejectStop) => {
              if (runningServer) {
                runningServer.close((err) => {
                  if (err) return rejectStop(err)
                  logInfo('Server stopped')
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
        logError('Server error:', err)
        reject(err)
      })

    } catch (err) {
       logError('Failed to start server:', err)
       reject(err)
    }

  })
}

module.exports = { createProxy } 