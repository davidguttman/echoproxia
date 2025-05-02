# Tutorial: Include Plaintext Body in Recordings

This tutorial demonstrates how to add an option to Echoproxia to include a plaintext representation of the response body directly in the recording file, alongside the existing base64-encoded chunks. This can make recordings easier to inspect manually.

## Prerequisites

*   Completion of the steps in `03-per-sequence-mode-override.md`.
*   Your Echoproxia implementation now supports per-sequence mode overrides.

## Goal

Introduce a new option `includePlainTextBody` to `createProxy`. When set to `true`, the `.echo.json` recording files will contain an additional field, `bodyPlainText`, holding the decoded response body as a UTF-8 string. If decoding fails (e.g., for binary data), this field might contain an error message or be omitted.

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
    Locate the `onProxyRes` handler within the `createProxyMiddleware` options (inside the `else` block for Record Mode). In the `proxyRes.on('data', ...)` callback, ensure chunks are collected (the current code already collects them as base64 strings in an array, let's call it `recordedChunks`).
    Update the `proxyRes.on('end', ...)` callback to attempt decoding these collected base64 chunks to generate and add the plaintext body if the option is enabled.

    ```javascript
    // Inside src/index.js, within createProxy > app.use(async (req, res, next) => { ... }
    // Find the 'else' block for Record Mode (activeSequenceEffectiveMode === true)
    // Inside createProxyMiddleware({ ... })
    onProxyRes: (proxyRes, req, res) => {
      // Existing logic collects chunks as base64 strings:
      const recordedChunks = []; // Example: ['eyJoZWxsb...','G8gV29ybGQh...', ...]
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
        recordedChunks.push(chunk.toString('base64'));
      });
      // ... (rest of 'data' handler) ...

      proxyRes.on('end', async () => {
        // 1. Signal the end of the response stream to the client
        res.end();

        // 2. Now, process and save the recording with the captured chunks
        const responseStatus = proxyRes.statusCode;
        const headersForRecording = redactHeaders({ ...proxyRes.headers }, headersToRedact);
        const recordingFilename = sanitizeFilename(req.path);
        const recordingFilepath = path.join(currentRecordingsDir, currentSequenceName, recordingFilename);

        // <<< START New Plaintext Logic >>>
        let plainTextBody = null;
        if (shouldIncludePlainText) {
          try {
            // Concatenate by decoding each base64 chunk first
            const responseBuffer = Buffer.concat(recordedChunks.map(base64Chunk => Buffer.from(base64Chunk, 'base64')));
            // Attempt basic UTF-8 decoding from the complete buffer.
            // Note: This won't handle all encodings or binary data perfectly.
            // More sophisticated decoding based on content-type could be added here.
            plainTextBody = responseBuffer.toString('utf8');
          } catch (decodeError) {
            logWarn(`Could not decode response body to UTF-8 for ${recordingFilename}: ${decodeError.message}`);
            plainTextBody = `[Echoproxia: Failed to decode body as UTF-8 - ${decodeError.message}]`;
          }
        }
        // <<< END New Plaintext Logic >>>

        const recordedRequest = {
          // ... existing request properties ...
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl,
          headers: redactHeaders(req.headers, headersToRedact),
          body: req.body instanceof Buffer ? req.body.toString('base64') : (typeof req.body === 'string' ? req.body : null)
        };

        const recordedResponse = {
          status: responseStatus,
          headers: headersForRecording,
          // <<< Add the new field conditionally >>>
          ...(plainTextBody !== null && { bodyPlainText: plainTextBody }),
          // Use the already collected base64 chunks
          chunks: recordedChunks 
        };

        logInfo(`Recording ${recordedResponse.chunks.length} chunks for ${req.path} to ${recordingFilename} (PlainText: ${shouldIncludePlainText})`)
        await writeRecording(recordingFilepath, { request: recordedRequest, response: recordedResponse });

        // ... (optional logging) ...
      });

      // ... (existing proxyRes.on('error')) ...
    },
    // ... (existing onError) ...
    ```

3.  **Updated Recording Structure:**
    The `.echo.json` file structure for the `response` object will now look like this when `includePlainTextBody` is `true`:

    ```json
    {
      "status": 200,
      "headers": { ... },
      "bodyPlainText": "{\"message\": \"Success!\"}", // <<< Optional field
      "chunks": [
        "eyJoZWxsbyI6ICJ3b3JsZCJ9"
        // ... more chunks if applicable ...
      ]
    }
    ```

4.  **Update Tests (Recommended):**
    Modify existing tests or add new ones to verify the presence or absence of the `bodyPlainText` field based on the `includePlainTextBody` option passed to `createProxy`. 

    Example assertion snippet for a test where `includePlainTextBody` is true:
    ```javascript
    // Inside an ava test
    const recordings = JSON.parse(await fs.readFile(recordingFilePath, 'utf8'));
    t.is(recordings.length, 1);
    const recordedResponse = recordings[0].response;
    t.truthy(recordedResponse.bodyPlainText, 'Expected bodyPlainText field to exist');
    t.is(recordedResponse.bodyPlainText, 'Expected decoded content here'); // Compare with expected string
    t.truthy(Array.isArray(recordedResponse.chunks), 'Chunks should still exist'); 
    ```

5.  **Update Documentation (`README.md`):**
    Add the `includePlainTextBody` option to the `createProxy(options)` documentation in the main `README.md` file.

    ```markdown
    *   **`options`** `<Object>` Configuration options:
        *   ...
        *   `redactHeaders` `<Array<String>>` *Optional.* ...
        *   `includePlainTextBody` `<Boolean>` *Optional.* If `true`, attempts to decode the response body as UTF-8 and includes it as `bodyPlainText` in recordings. Defaults to `false`.
    ```

## Outcome

Echoproxia can now optionally include a human-readable version of the response body in its recordings, simplifying debugging and inspection, while still retaining the raw chunk data for accurate replay. 