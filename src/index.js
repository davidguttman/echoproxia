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

async function createProxy (options = {}) {
  const {
    recordMode = false,
    targetUrl = 'http://localhost', // Need a default or make required
    recordingsDir = path.join(process.cwd(), '__recordings__'),
    defaultSequenceName = 'default-sequence',
    redactHeaders: headersToRedactInput = ['authorization'], // Default redaction
    includePlainTextBody = false // <<< Add new option with default
  } = options

  // --- State (scoped within createProxy) ---
  let currentRecordMode = recordMode
  let currentTargetUrl = targetUrl
  let currentRecordingsDir = recordingsDir
  let currentSequenceName = defaultSequenceName
  const replayCounters = {}
  const headersToRedact = headersToRedactInput.map(h => h.toLowerCase())
  let runningServer = null
  const shouldIncludePlainText = includePlainTextBody // <<< Store the option value
  // <<< RE-ADD isWriting flag >>>
  let isWriting = false;
  // <<< ADD isStopping flag >>>
  let isStopping = false;
  // --- End State ---

  // <<< NEW: In-memory store for recordings >>>
  const inMemoryRecordings = {}; // { sequenceName: { sanitizedFilePath: [interaction, ...] } }

  // <<< NEW: Queue mechanism for file writes (INSIDE createProxy) >>>
  const writeQueue = []; // Array of { filePath: string, recordingsArray: any[] }

  // <<< Queue processing function (INSIDE createProxy) >>>
  async function processWriteQueue () {
    // <<< Set isWriting flag >>>
    if (isWriting) return; // Prevent concurrent processing loops

    const job = writeQueue.shift(); // Get next task (if any)

    if (!job) {
      // No job, just schedule next check and exit this tick
      if (!isStopping) setImmediate(processWriteQueue);
      return;
    }

    // Found a job, mark as writing
    isWriting = true; 

    try {
      // Only attempt write if a job exists (redundant check now, but safe)
      if (job) { 
        // <<< Revert to minimal log >>>
        logInfo(`Processing write job for ${job.filePath} (${job.recordingsArray.length} items)`);
        const sequencePath = path.dirname(job.filePath);
        // Ensure the base directory for the sequence exists
        await fs.mkdir(sequencePath, { recursive: true });
        // Overwrite the file with the stringified full array
        await fs.writeFile(job.filePath, JSON.stringify(job.recordingsArray, null, 2));
        // <<< Revert to minimal log >>>
        logInfo(`Wrote ${job.recordingsArray.length} interactions to ${job.filePath}`);
      } // else { logInfo('Write queue empty, skipping write.'); } // Optional log
    } catch (error) {
      // Log error only if we were actually processing a job
      if (job) { 
        // <<< Revert to standard error log >>>
        logError(`Error writing recordings to file ${job.filePath} from queue:`, error);
      }
      // Continue processing next item even if one fails?
    } finally {
      // Unset isWriting flag
      isWriting = false;
      // ALWAYS Schedule the next iteration AFTER this one completes/errors
      // <<< Only schedule if not stopping >>>
      if (!isStopping) {
        setImmediate(processWriteQueue); 
      } else {
        logInfo('PROCESS_QUEUE: isStopping is true, loop terminates.');
      }
    }
  }

  // <<< Function to add to queue (INSIDE createProxy) >>>
  async function writeRecordingsToFile (filePath, recordingsArray) {
    /*
    // <<< REMOVE queue empty check >>>
    const queueWasEmpty = writeQueue.length === 0;
    */

    // Add the task to the queue
    writeQueue.push({ filePath, recordingsArray });
    logInfo(`Queued write for ${filePath} (${recordingsArray.length} items, queue size: ${writeQueue.length})`); 
    
    // <<< REMOVE Conditional kickstart >>>
    /*
    // Kickstart the queue processor ONLY if it wasn't already running
    if (queueWasEmpty) {
      logInfo('Queue was empty, starting processor.');
      processWriteQueue(); // Start the loop
    }
    */
  }
  // <<< END Queue functions >>>

  // <<< START the perpetual queue processor >>>
  processWriteQueue();

  // --- New State Variable ---
  let activeSequenceEffectiveMode = currentRecordMode // Initialize with global mode
  // --- End New State Variable ---

  // --- Initial Sequence Directory Cleanup (if in record mode) ---
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

  // --- Internal setSequence Function ---
  // Moved from the returned object to be internal, accepting options
  const internalSetSequence = async (sequenceName, options = {}) => {
    const { recordMode: sequenceOverrideMode } = options // Get override boolean

    // Determine the effective mode for this sequence activation
    // Use override if provided (true/false), otherwise use global (currentRecordMode)
    const effectiveMode = typeof sequenceOverrideMode === 'boolean'
      ? sequenceOverrideMode
      : currentRecordMode // Use global mode as fallback

    logInfo(`Setting sequence: ${sequenceName}, GlobalMode: ${currentRecordMode}, Override: ${sequenceOverrideMode}, EffectiveMode: ${effectiveMode ? 'record' : 'replay'}`)

    // --- Sequence Recording Cleanup Logic (Uses effectiveMode) ---
    if (effectiveMode === true) { // Only clear if effective mode is record
      const sequencePath = path.join(currentRecordingsDir, sequenceName)
      logInfo(`Effective mode is \'record\': Clearing in-memory recordings and deleting directory for sequence: ${sequenceName}`);
      // Clear memory for this sequence
      inMemoryRecordings[sequenceName] = {};
      // <<< ADD directory deletion >>>
      try {
        // Delete the sequence directory recursively
        await fs.rm(sequencePath, { recursive: true, force: true });
        logInfo(`Deleted sequence directory: ${sequencePath}`);
      } catch (rmErr) {
        // Ignore ENOENT (dir doesn't exist), log others
        if (rmErr.code !== 'ENOENT') {
          logError(`Error deleting sequence directory ${sequencePath}:`, rmErr);
        } else {
          logInfo(`Sequence directory ${sequencePath} did not exist, nothing to delete.`);
        }
      }
      /* OLD file-by-file deletion logic commented out previously */
    } else {
      logInfo(`Effective mode is \'replay\': Skipping cleanup for ${sequenceName}`);
    }
    // --- End Cleanup Logic ---

    // Store the determined effective mode for the main handler
    activeSequenceEffectiveMode = effectiveMode

    // Original logic to set the name and reset counters
    currentSequenceName = sequenceName
    logInfo(`Sequence set to: ${currentSequenceName}`)
    // Ensure replayCounters exist for the sequence
    if (!replayCounters[currentSequenceName]) {
      replayCounters[currentSequenceName] = {}
    }
  }
  // --- End Internal setSequence Function ---

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
    sequenceReplayState[usedFilepath] = currentIndex + 1; // Update counter

    // --- Updated Replay Logic (using response.body) ---
    // Check if the 'body' field exists and is a string (base64)
    if (typeof recordedResponse.body !== 'string') {
      logError(`Replay Error: Recording at index ${currentIndex} for ${usedFilepath} is missing or has invalid 'body' format (expected base64 string).`);
      res.status(500).send(`Echoproxia Replay Error: Invalid recording format (missing body) for path ${req.path} in sequence ${currentSequenceName}.`);
      return false; // Indicate failure
    }

    // 1. Send Headers
    res.status(recordedResponse.status);
    Object.entries(recordedResponse.headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      // Filter potentially problematic headers
      if (lowerKey !== 'content-length' && lowerKey !== 'transfer-encoding') { 
          try {
              res.setHeader(key, value);
          } catch (headerErr) {
              logWarn(`Could not set header during replay ${key}: ${value} - ${headerErr.message}`);
          }
      }
    });
    // Don't manually set Content-Length, let Express handle it based on the buffer write.
    res.writeHead(recordedResponse.status);

    // 2. Decode and Send Body
    try {
      const responseBuffer = Buffer.from(recordedResponse.body, 'base64');
      res.write(responseBuffer);
    } catch (decodeErr) {
      logError(`Replay Error: Failed to decode base64 body at index ${currentIndex} for ${usedFilepath}: ${decodeErr.message}`);
      res.status(500).send(`Echoproxia Replay Error: Failed to decode recorded body for path ${req.path}.`);
      // Ensure response ends even on error before returning
      if (!res.writableEnded) {
          res.end();
      }
      return false;
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

    // Use the EFFECTIVE mode for the currently active sequence
    if (activeSequenceEffectiveMode === false) {
      // Replay Mode
      const replayed = await handleReplay(req, res, { /* other context if needed */ })
      
      // handleReplay sends the response on success or failure.
      // If it failed but somehow didn't send headers, log it, but we must stop here.
      if (!replayed && !res.headersSent) {
        logError('handleReplay indicated failure but headers were not sent. Sending fallback 500.');
        // Ensure a response is sent ONLY if handleReplay failed to do so.
        res.status(500).send('Internal Echoproxia Replay Error: Failed to send replay response.');
      }
      // >>> FIX RE-APPLIED (Final): Explicitly return to prevent falling through <<<
      return; 
    } else {
      // Record Mode - Create and call the proxy middleware instance
      logInfo(`Record mode active for ${req.path}, proxying to ${currentTargetUrl}`);
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

          const responseBodyChunks = []; // Rename for clarity, store raw chunks
          // let completeBodyForLogging = Buffer.alloc(0) // Removed, less useful now

          proxyRes.on('data', (chunk) => {
            res.write(chunk); // Stream to client
            responseBodyChunks.push(chunk); // Store raw chunk for processing later
          });

          proxyRes.on('end', async () => {
            res.end(); // End client response

            const responseStatus = proxyRes.statusCode;
            const responseHeaders = proxyRes.headers; // Keep original headers for checks
            const headersForRecording = redactHeaders({ ...responseHeaders }, headersToRedact);
            const recordingFilename = sanitizeFilename(req.path);
            const recordingFilepath = path.join(currentRecordingsDir, currentSequenceName, recordingFilename);

            const responseBuffer = Buffer.concat(responseBodyChunks); // Complete raw response body

            // <<< START Decompress and Decode Response Body Conditionally >>>
            let responseBodyPlainText = null;
            // Always store the original (potentially compressed) body as base64 for accurate replay
            const responseBodyBase64 = responseBuffer.toString('base64'); 

            if (shouldIncludePlainText) {
                let bufferToDecode = responseBuffer;
                const contentEncoding = responseHeaders['content-encoding'];

                try {
                    // Decompress if necessary
                    if (contentEncoding === 'gzip') {
                        bufferToDecode = zlib.gunzipSync(responseBuffer);
                        logInfo(`Decompressed GZIP response for ${recordingFilename}`);
                    } else if (contentEncoding === 'deflate') {
                        bufferToDecode = zlib.inflateSync(responseBuffer);
                        logInfo(`Decompressed DEFLATE response for ${recordingFilename}`);
                    } // Add other encodings like 'br' (brotli) if needed with require('iltorb') or similar

                    // Now attempt UTF-8 decoding on the (potentially decompressed) buffer
                    responseBodyPlainText = bufferToDecode.toString('utf8');
                } catch (err) {
                    // Log error with encoding info
                    logWarn(`Could not decompress/decode response body for ${recordingFilename} (Encoding: ${contentEncoding || 'none'}): ${err.message}`);
                    responseBodyPlainText = `[Echoproxia: Failed to decompress/decode response body as UTF-8 - ${err.message}]`;
                }
            }
            // <<< END Decompress and Decode Response Body Conditionally >>>

            // <<< Decode Request Body Conditionally >>>
            let requestBodyPlainText = null;
            // Prefer req.body directly if bodyParser middleware ran (like express.raw)
            const originalRequestBodyBuffer = req.body instanceof Buffer ? req.body : null; 
            const originalRequestBodyBase64 = originalRequestBodyBuffer ? originalRequestBodyBuffer.toString('base64') : null;

            if (shouldIncludePlainText && originalRequestBodyBuffer) {
                try {
                    requestBodyPlainText = originalRequestBodyBuffer.toString('utf8');
                } catch (decodeError) {
                    logWarn(`Could not decode request body to UTF-8 for ${recordingFilename}: ${decodeError.message}`);
                    requestBodyPlainText = `[Echoproxia: Failed to decode request body as UTF-8 - ${decodeError.message}]`;
                }
            }
            // <<< End Decode Request Body Conditionally >>>

            const recordedRequest = {
              method: req.method,
              path: req.path,
              originalUrl: req.originalUrl,
              headers: redactHeaders(req.headers, headersToRedact),
              // Store original request body as base64
              body: originalRequestBodyBase64, 
              // Add plaintext request body conditionally
              ...(requestBodyPlainText !== null && { bodyPlainText: requestBodyPlainText })
            };

            // Store full original response body as base64, remove chunks
            const recordedResponse = {
              status: responseStatus,
              headers: headersForRecording,
              ...(responseBodyPlainText !== null && { bodyPlainText: responseBodyPlainText }),
              // Replace chunks with single base64 body for consistency and replay
              body: responseBodyBase64 
              // chunks: recordedChunks // DEPRECATED
            };

            // <<< MODIFY: Store in memory AND trigger immediate write >>>
            const interaction = { request: recordedRequest, response: recordedResponse };

            // Ensure sequence entry exists in memory
            if (!inMemoryRecordings[currentSequenceName]) {
              inMemoryRecordings[currentSequenceName] = {};
            }
            // Ensure path entry array exists in memory
            if (!inMemoryRecordings[currentSequenceName][recordingFilename]) {
              inMemoryRecordings[currentSequenceName][recordingFilename] = [];
            }
            // Append interaction to memory
            inMemoryRecordings[currentSequenceName][recordingFilename].push(interaction);

            // Get the full updated array from memory
            const updatedRecordingsForPath = inMemoryRecordings[currentSequenceName][recordingFilename];

            logInfo(`Recording interaction ${updatedRecordingsForPath.length} for ${req.path} to ${recordingFilename} (Queuing write)`);
            // Trigger write queue processing (no await)
            writeRecordingsToFile(recordingFilepath, updatedRecordingsForPath);
            /* 
            // OLD direct write call:
            // logInfo(`Recording interaction for ${req.path} to ${recordingFilename} (PlainText: ${shouldIncludePlainText})`);
            // await writeRecording(recordingFilepath, { request: recordedRequest, response: recordedResponse });
            */

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
      proxyMiddlewareInstance(req, res, next) // This line should only be reached in Record mode
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
          setSequence: async (sequenceName, sequenceOptions = {}) => { // Keep async
            // Await the internal function which handles async cleanup
            await internalSetSequence(sequenceName, sequenceOptions)
          },
          // Add setMode, setTargetUrl etc. if needed for runtime changes
          stop: async () => {
            // <<< Set stopping flag >>>
            logInfo('STOP: Setting isStopping flag.');
            isStopping = true;

            logInfo(`Stop requested. Waiting for write queue and active write...`);
            while (writeQueue.length > 0 || isWriting) {
              await new Promise(resolve => setTimeout(resolve, 10)); // Keep the wait
            }
            logInfo(`STOP: Write queue drained and no active write.`);

            return new Promise((resolveStop, rejectStop) => {
              if (runningServer) {
                runningServer.close((err) => {
                  if (err) {
                    return rejectStop(err)
                  }
                  logInfo('Server stopped'); // Keep standard stop log
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