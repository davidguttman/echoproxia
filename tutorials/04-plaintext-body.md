# Tutorial: Include Plaintext Body in Recordings

This tutorial demonstrates how to add an option to Echoproxia to include a plaintext representation of **both the request and response bodies** directly in the recording file, alongside the existing base64-encoded data. This can make recordings easier to inspect manually.

## Prerequisites

*   Completion of the steps in `03-per-sequence-mode-override.md`.
*   Your Echoproxia implementation now supports per-sequence mode overrides.

## Goal

Introduce a new option `includePlainTextBody` to `createProxy`. When set to `true`, the `.echo.json` recording files will contain additional fields, `bodyPlainText`, in **both the `request` and `response` objects**, holding the decoded body as a UTF-8 string. If decoding fails (e.g., for binary data), this field might contain an error message or be omitted.

## Steps

1.  **Add Option to `createProxy`:**
    Modify the `createProxy` function signature to accept the new option and store its value.

    ```javascript
    // Inside src/index.js
    async function createProxy (options = {}) {
      const {
        recordMode = false,
        targetUrl = 'http://localhost',
        recordingsDir = path.join(process.cwd(), '__recordings__'),
        defaultSequenceName = 'default-sequence',
        redactHeaders: headersToRedactInput = ['authorization'],
        includePlainTextBody = false // <<< Add new option with default
      } = options

      // ... existing state variables ...
      const shouldIncludePlainText = includePlainTextBody // <<< Store the option value
      // ... rest of createProxy ...
    }
    ```

2.  **Modify `onProxyRes` Recording Logic:**
    Locate the `onProxyRes` handler within the `createProxyMiddleware` options (inside the `else` block for Record Mode). Update the `proxyRes.on('end', ...)` callback:
    *   Attempt decoding the collected **response body** chunks and add `response.bodyPlainText` if the option is enabled.
    *   Attempt decoding the **request body** (which might be a buffer or string) and add `request.bodyPlainText` if the option is enabled.

    ```javascript
    // Inside src/index.js, within createProxy > app.use(async (req, res, next) => { ... }
    // Find the 'else' block for Record Mode (activeSequenceEffectiveMode === true)
    // Inside createProxyMiddleware({ ... })
    onProxyRes: (proxyRes, req, res) => {
      // --- Import zlib at the top of your src/index.js if not already there ---
      // const zlib = require('zlib'); 
      // ------------------------------------------------------------------------

      // ... (existing header forwarding, chunk collection setup) ...
      const responseBodyChunks = []; // Renamed for clarity
      proxyRes.on('data', (chunk) => {
          responseBodyChunks.push(chunk); // Store raw chunks
          // Note: We no longer store base64 chunks here directly if aiming for plaintext
      });

      proxyRes.on('end', async () => {
        res.end(); // End the client response first
        
        const responseBuffer = Buffer.concat(responseBodyChunks);
        const responseStatus = proxyRes.statusCode;
        const responseHeaders = proxyRes.headers; // Keep original headers
        const recordingFilename = generateFilename(req);
        const sequenceDir = path.join(recordingsDir, activeSequenceName);
        const recordingFilepath = path.join(sequenceDir, recordingFilename);

        await fs.ensureDir(sequenceDir); // Ensure directory exists

        const headersForRecording = redactHeaders(responseHeaders, headersToRedact); // Redact original headers for recording

        // <<< START Decompress and Decode Response Body Conditionally >>>
        let responseBodyPlainText = null;
        let responseBodyBase64 = responseBuffer.toString('base64'); // Keep base64 for chunks field always

        if (shouldIncludePlainText) {
            let bufferToDecode = responseBuffer;
            const contentEncoding = responseHeaders['content-encoding'];

            try {
                // Decompress if necessary
                if (contentEncoding === 'gzip') {
                    bufferToDecode = zlib.gunzipSync(responseBuffer);
                } else if (contentEncoding === 'deflate') {
                    bufferToDecode = zlib.inflateSync(responseBuffer);
                } // Add other encodings like 'br' (brotli) if needed

                // Now attempt UTF-8 decoding
                responseBodyPlainText = bufferToDecode.toString('utf8');
            } catch (err) {
                logWarn(`Could not decompress/decode response body for ${recordingFilename} (Encoding: ${contentEncoding || 'none'}): ${err.message}`);
                responseBodyPlainText = `[Echoproxia: Failed to decompress/decode response body as UTF-8 - ${err.message}]`;
            }
        }
        // <<< END Decompress and Decode Response Body Conditionally >>>

        // <<< START Decode Request Body Conditionally (No change needed here usually, request bodies typically aren't compressed in the same way) >>>
        let requestBodyPlainText = null;
        // Use req.originalBody which should be populated by a body parser middleware before proxying
        const originalRequestBodyBuffer = req.originalBody instanceof Buffer ? req.originalBody : null;
        const originalRequestBodyBase64 = originalRequestBodyBuffer ? originalRequestBodyBuffer.toString('base64') : null; 

        if (shouldIncludePlainText && originalRequestBodyBuffer) {
            try {
                requestBodyPlainText = originalRequestBodyBuffer.toString('utf8');
            } catch (decodeError) {
                logWarn(`Could not decode request body to UTF-8 for ${recordingFilename}: ${decodeError.message}`);
                requestBodyPlainText = `[Echoproxia: Failed to decode request body as UTF-8 - ${decodeError.message}]`;
            }
        }
        // <<< END Decode Request Body Conditionally >>>

        const recordedRequest = {
            method: req.method,
            path: req.path, // Use req.path which is relative to the proxy mount point
            originalUrl: req.originalUrl, // Keep originalUrl for potential full path context
            headers: redactHeaders(req.headers, headersToRedact), // Redact incoming request headers
            body: originalRequestBodyBase64, // Store original request body as base64 always
            ...(requestBodyPlainText !== null && { bodyPlainText: requestBodyPlainText }) 
        };

        const recordedResponse = {
            status: responseStatus,
            headers: headersForRecording, // Use redacted headers here
            ...(responseBodyPlainText !== null && { bodyPlainText: responseBodyPlainText }), 
            // Keep the original (potentially compressed) body as base64 for accurate replay
            body: responseBodyBase64 
            // Deprecate 'chunks' if 'body' serves the full base64 content
            // chunks: [responseBodyBase64] // Or just store the full base64 body once
        };
        
        const recordingData = { request: recordedRequest, response: recordedResponse };

        // ... (Write recording logic - needs adjustment if 'chunks' is removed/changed) ...
        // Assuming write logic uses recordingData now
         try {
            // If file exists (record mode implies overwrite for simplicity in this tutorial stage)
            // Note: Real implementation might append or use different logic based on 02-safer-recordings
            await fs.writeFile(recordingFilepath, JSON.stringify(recordingData, null, 2)); // Write single interaction object
            logInfo(`Recorded: ${recordingFilename} in ${activeSequenceName}`);
         } catch (writeError) {
            logError(`Failed to write recording ${recordingFilename}: ${writeError}`);
         }
      });

      // ... (existing proxyRes.on('error')) ...
    },
    // ... (existing onError) ...
    ```

3.  **Updated Recording Structure:**
    The `.echo.json` file structure will now look like this when `includePlainTextBody` is `true`:

    ```json
    {
      "request": {
        "method": "POST",
        "path": "/example",
        "headers": { ... },
        "body": "eyJrZXkiOiAidmFsdWUifQ==", // Original (potentially base64)
        "bodyPlainText": "{\"key\": \"value\"}" // <<< Optional field
      },
      "response": {
        "status": 200,
        "headers": { ... },
        "bodyPlainText": "{\"message\": \"Success!\"}", // <<< Optional field
        "body": "eyJtZXNzYWdlIjogIlN1Y2Nlc3MhIn0=" // <<< Optional field
      }
    }
    ```

4.  **Update Tests (Recommended):**
    Modify existing tests or add new ones to verify the presence or absence of the `bodyPlainText` field in **both the request and response objects** based on the `includePlainTextBody` option.

    Example assertion snippet for a test where `includePlainTextBody` is true:
    ```javascript
    // Inside an ava test
    const recordings = JSON.parse(await fs.readFile(recordingFilePath, 'utf8'));
    t.is(recordings.length, 1);
    const recordedRequest = recordings[0].request;
    const recordedResponse = recordings[0].response;
    
    // Check Request
    t.truthy(recordedRequest.bodyPlainText, 'Expected request.bodyPlainText field to exist');
    t.is(recordedRequest.bodyPlainText, 'Expected decoded request content here');
    t.truthy(recordedRequest.body, 'Expected original request.body field to exist');

    // Check Response
    t.truthy(recordedResponse.bodyPlainText, 'Expected response.bodyPlainText field to exist');
    t.is(recordedResponse.bodyPlainText, 'Expected decoded response content here');
    t.truthy(Array.isArray(recordedResponse.body), 'Chunks should still exist');
    ```

5.  **Update Documentation (`README.md`):**
    Ensure the description of `includePlainTextBody` in `README.md` mentions it applies to both request and response bodies.

    ```markdown
    *   **`options`** `<Object>` Configuration options:
        *   ...
        *   `includePlainTextBody` `<Boolean>` *Optional.* If `true`, attempts to decode **both the request and response bodies** as UTF-8 and includes them as `bodyPlainText` in recordings. Defaults to `false`.
    ```

## Outcome

Echoproxia can now optionally include human-readable versions of **both request and response bodies** in its recordings, simplifying debugging and inspection, while still retaining the raw data for accurate replay and request representation. 