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
      // ... (existing header forwarding, chunk collection setup) ...
      const recordedChunks = [];
      proxyRes.on('data', (chunk) => { /* ... collect base64 chunks ... */ });

      proxyRes.on('end', async () => {
        res.end();
        // ... (get status, headers, filename, filepath) ...

        // <<< START Decode Response Body Conditionally >>>
        let responseBodyPlainText = null;
        if (shouldIncludePlainText) {
          try {
            const responseBuffer = Buffer.concat(recordedChunks.map(base64Chunk => Buffer.from(base64Chunk, 'base64')));
            responseBodyPlainText = responseBuffer.toString('utf8');
          } catch (decodeError) {
            logWarn(`Could not decode response body to UTF-8 for ${recordingFilename}: ${decodeError.message}`);
            responseBodyPlainText = `[Echoproxia: Failed to decode response body as UTF-8 - ${decodeError.message}]`;
          }
        }
        // <<< END Decode Response Body Conditionally >>>

        // <<< START Decode Request Body Conditionally >>>
        let requestBodyPlainText = null;
        let originalRequestBody = req.body instanceof Buffer ? req.body.toString('base64') : (typeof req.body === 'string' ? req.body : null);
        if (shouldIncludePlainText && originalRequestBody) {
            try {
                const requestBuffer = req.body instanceof Buffer ? req.body : Buffer.from(originalRequestBody, 'utf8');
                requestBodyPlainText = requestBuffer.toString('utf8');
            } catch (decodeError) {
                logWarn(`Could not decode request body to UTF-8 for ${recordingFilename}: ${decodeError.message}`);
                requestBodyPlainText = `[Echoproxia: Failed to decode request body as UTF-8 - ${decodeError.message}]`;
            }
        }
        // <<< END Decode Request Body Conditionally >>>

        const recordedRequest = {
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl,
          headers: redactHeaders(req.headers, headersToRedact),
          body: originalRequestBody, // Original request body (string or base64)
          ...(requestBodyPlainText !== null && { bodyPlainText: requestBodyPlainText }) // <<< Add conditional plaintext
        };

        const recordedResponse = {
          status: responseStatus,
          headers: headersForRecording,
          ...(responseBodyPlainText !== null && { bodyPlainText: responseBodyPlainText }), // <<< Add conditional plaintext
          chunks: recordedChunks // Original base64 chunks
        };

        // ... (write recording) ...
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
        "chunks": [
          "eyJoZWxsbyI6ICJ3b3JsZCJ9"
        ]
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
    t.truthy(Array.isArray(recordedResponse.chunks), 'Chunks should still exist');
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