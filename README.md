# Echoproxia

Echoproxia provides a simple Express-based HTTP proxy server designed for recording and replaying HTTP interactions during testing. It allows dynamically switching between different recording sequences (e.g., for different tests or test steps) while the server is running.

It operates in two modes:

*   **Record Mode:** Forwards requests to a specified target URL, records the request/response pairs sequentially for each URL path, and saves them to disk under the currently active recording sequence name (within a base directory).
*   **Replay Mode:** Serves previously recorded responses sequentially for incoming requests based on the URL path and the currently active recording sequence name.

This is useful for creating deterministic tests that don't rely on live external services and need to manage multiple interaction sequences.

## Installation

```bash
npm install --save-dev echoproxia
# or
yarn add --dev echoproxia
```

## Usage Example

```javascript
// In your test setup file (e.g., using ava)
const test = require('ava')
const path = require('path')
const { createProxy } = require('echoproxia') // Use the module name

// Determine mode based on environment (can be overridden in createProxy options)
const recordMode = process.env.RECORD_MODE === 'true'
// Example: Store recordings in a directory relative to the test file
const recordingsDir = path.join(__dirname, '__recordings__')

test.before(async t => {
  // createProxy now handles port finding and server starting
  // It returns an object with server control and details
  const proxy = await createProxy({
    // port: 5000, // Optionally specify a port
    targetUrl: 'https://api.example.com', // The actual API endpoint
    recordingsDir: recordingsDir,
    recordMode: recordMode,
    redactHeaders: ['authorization', 'x-api-key']
  })

  // Store the proxy control object on the context
  t.context.proxy = proxy

  // Now you can access the proxy's URL and control functions
  console.log(`Echoproxia running in ${recordMode ? 'record' : 'replay'} mode on ${t.context.proxy.url}, using base directory ${recordingsDir}`)

  // Configure your application to use the proxy url directly
  // Example: myApiClient.setBaseUrl(t.context.proxy.url)
})

test.after.always(async t => {
  // Use the stop method returned by createProxy
  if (t.context.proxy && t.context.proxy.stop) {
    await t.context.proxy.stop()
    console.log('Echoproxia stopped')
  }
})

// Example tests using different sequences
test('Test Scenario 1', async t => {
  t.context.proxy.setSequence('test-scenario-1') // Activate the sequence via context
  // Your application code making requests (using the configured base URL)
  // e.g., await fetch(`${t.context.proxy.url}/some/path`)
  t.pass()
})

test('Test Scenario 2', async t => {
  t.context.proxy.setSequence('test-scenario-2') // Activate the sequence via context
  // Your application code making requests (using the configured base URL)
  // e.g., await fetch(`${t.context.proxy.url}/another/path`)
  t.pass()
})

## API

### `async createProxy(options)`

Creates and starts an Echoproxia instance, returning controls and details.

*   **`options`** `<Object>` Configuration options:
    *   `port` `<Number>` *Optional.* The port to listen on. If omitted, an available random port will be chosen.
    *   `targetUrl` `<String>` **Required.** The base URL to proxy requests to when in `recordMode`.
    *   `recordingsDir` `<String>` **Required.** The absolute path to the base directory where recording sequence subdirectories should be stored.
    *   `recordMode` `<Boolean>` **Required.** If `true`, operates in record mode. If `false`, operates in replay mode.
    *   `redactHeaders` `<Array<String>>` *Optional.* An array of lowercase header names whose values should be replaced with `[REDACTED]` in recordings. Defaults to `['authorization']`.
*   **Returns** `<Promise<Object>>` A Promise that resolves to an object with the following properties:
    *   `port` `<Number>`: The actual port the proxy server is listening on.
    *   `url` `<String>`: The base URL of the running proxy server (e.g., `http://localhost:<port>`).
    *   `server` `<http.Server>`: The underlying Node.js HTTP Server instance. Can be used to close the server (e.g., `proxy.server.close()`).
    *   `setSequence` `<Function>`: An asynchronous function `async (sequenceName <String>, options <Object>) => void` that sets the active recording sequence name. Recordings will be read from/written to `<recordingsDir>/<sequenceName>/` after this is called.
        *   The optional `options` object can contain:
            *   `recordMode` `<Boolean>`: If provided (`true` or `false`), this overrides the global `recordMode` setting for *this specific sequence activation*. If omitted, the global mode is used.
    *   `stop` `<Function>`: An asynchronous function `async () => void` that stops the proxy server.

## Recording and Replay Mechanism

*   The active recording sequence is determined by the last call to the `setSequence(sequenceName, options)` function.
*   The *effective* mode (record or replay) for the current sequence is determined by the `options.recordMode` passed to `setSequence`, falling back to the global `recordMode` if the option is not provided.
*   **Recording:** When the *effective mode* for the current sequence is `record`, calling `setSequence` will first **delete all existing `*.echo.json` files** within the directory `<recordingsDir>/<sequenceName>/`. Subsequently, each request proxied under that sequence name is saved. The recordings are stored in `.echo.json` files within the sequence directory: `<recordingsDir>/<sequenceName>/`. Each unique URL path gets its own JSON file (e.g., `_v1_users.echo.json`), containing an array with a single interaction (`{ request, response }`). This ensures recordings always reflect the latest session for a given sequence name when in record mode.
*   **Replay:** When the *effective mode* is `replay`, the proxy expects incoming requests to match the sequence recorded for the active `sequenceName`. When a request for a specific path arrives, the proxy finds the corresponding `.echo.json` file (falling back to `.json` for backwards compatibility) in the active sequence directory and serves the *next* available response from the recorded array (FIFO order). If no recording exists for the path, or if the sequence is exhausted, a 500 error is returned.

```javascript
// Example demonstrating sequence override
test.before(async t => {
  const proxy = await createProxy({
    targetUrl: 'https://api.example.com',
    recordingsDir: '/path/to/recordings',
    recordMode: true // Global mode is record
  });
  t.context.proxy = proxy;
});

test('Force Replay for this test', async t => {
  // Even though global mode is 'record', force 'replay' for this sequence
  await t.context.proxy.setSequence('stable-replay-sequence', { recordMode: false });
  // ... requests will now be replayed from 'stable-replay-sequence'
  t.pass();
});

test('Use Global Record for this test', async t => {
  // No override provided, uses the global 'record' mode
  await t.context.proxy.setSequence('new-feature-sequence');
  // ... requests will now be recorded to 'new-feature-sequence'
  // Existing *.echo.json files in this sequence directory will be cleared first.
  t.pass();
});
```