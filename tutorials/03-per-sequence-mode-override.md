# Tutorial: Per-Sequence Mode Override

This tutorial builds upon the changes made in `02-safer-recordings-overwrite.md`, where we introduced the `.echo.json` file format and targeted cleanup.

Here, we add the ability to override the globally set `recordMode` for specific sequences directly when calling `setSequence`.

## Prerequisites

*   Completion of the steps in `02-safer-recordings-overwrite.md`.
*   Your Echoproxia implementation now uses `.echo.json`, clears only those files in record mode, and supports backwards-compatible reading.

## Goal

Allow forcing record or replay mode for a specific sequence activation, regardless of the global mode. For example, allow `setSequence('my-stable-test', { recordMode: false })` to force replay even if the proxy started with `recordMode: true`.

## Steps

1.  **Add State for Effective Mode:**
    Inside the `createProxy` scope, add a new state variable to hold the *effective* mode of the currently active sequence. This will be set by `setSequence` and read by the main request handler.

    ```javascript
    // Inside createProxy scope, with other state variables:
    let activeSequenceEffectiveMode = currentRecordMode; // Initialize with global mode
    ```

2.  **Update `setSequence` Signature and Logic:**
    Modify the `setSequence` function (returned by `createProxy`) to accept an optional `options` object. Determine the `effectiveMode` based on the global mode and any override provided. Use this `effectiveMode` for cleanup logic and store it in the new state variable.

    ```javascript
    // Inside createProxy, modify the setSequence function again:
    setSequence: async (sequenceName, options = {}) => { // Add options param
      const { recordMode: sequenceOverrideMode } = options; // Get override boolean

      // Determine the effective mode for this sequence activation
      // Use override if provided (true/false), otherwise use global (currentRecordMode)
      const effectiveMode = typeof sequenceOverrideMode === 'boolean'
        ? sequenceOverrideMode
        : currentRecordMode; // Use global mode as fallback

      logInfo(`Setting sequence: ${sequenceName}, GlobalMode: ${currentRecordMode}, Override: ${sequenceOverrideMode}, EffectiveMode: ${effectiveMode ? 'record' : 'replay'}`);

      // --- Sequence Recording Cleanup Logic (Uses effectiveMode) ---
      if (effectiveMode === true) { // Only clear if effective mode is record
        const sequencePath = path.join(currentRecordingsDir, sequenceName);
        logInfo(`Effective mode is 'record': Clearing *.echo.json files in: ${sequencePath}`);
        try {
          const filenames = await fs.readdir(sequencePath);
          for (const filename of filenames) {
            if (filename.endsWith('.echo.json')) { // Target specific files
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
      } else {
        logInfo(`Effective mode is 'replay': Skipping cleanup for ${sequenceName}`);
      }
      // --- End Cleanup Logic ---

      // Store the determined effective mode for the main handler
      activeSequenceEffectiveMode = effectiveMode;

      // Original logic to set the name and reset counters
      currentSequenceName = sequenceName
      logInfo(`Sequence set to: ${currentSequenceName}`)
      replayCounters[currentSequenceName] = {}
    },
    ```

3.  **Update Main Request Handler:**
    Modify the main middleware that decides whether to record or replay. Instead of checking the global `currentRecordMode`, it should now check the `activeSequenceEffectiveMode` state variable.

    ```javascript
    // Find the main app.use(async (req, res, next) => { ... }) middleware
    app.use(async (req, res, next) => {
      // ... (ignore /echoproxia/, construct recordingFilepathNew/Old etc.) ...

      // Check the EFFECTIVE mode for the currently active sequence
      if (activeSequenceEffectiveMode === false) { // << Check the effective mode state variable
        // Replay Mode logic
        logInfo(`Handling Replay for ${req.path} in sequence ${currentSequenceName}`);
        // Ensure handleReplay uses the backwards-compatible logic from previous tutorial
        const replayed = await handleReplay(req, res, { /* params */ })
        // ... (rest of replay error handling) ...
      } else {
        // Record Mode logic
        logInfo(`Handling Record for ${req.path} in sequence ${currentSequenceName}`);
        // Ensure proxyMiddlewareInstance uses sanitizeFilename correctly
        const proxyMiddlewareInstance = createProxyMiddleware({ /* ... options ... */ });
        proxyMiddlewareInstance(req, res, next);
      }
    })
    ```

4.  **Update `createProxy` Options (Recommended):**
    For consistency, consider changing the global `recordMode` option in `createProxy` to accept `true` or `false` explicitly (if it wasn't already). Update the initial cleanup logic and initialization of `activeSequenceEffectiveMode` accordingly.

## Outcome

You can now selectively force replay *or* record mode for specific sequences during runtime using `setSequence('sequence-name', { recordMode: boolean })`. If the option is omitted, the behavior falls back to the global mode set when the proxy was created.

## Updating Documentation

Ensure your main `README.md` reflects these capabilities:

*   Clearly document the `options` parameter for `setSequence`, specifically `{ recordMode: boolean }`, and explain how it overrides the global mode.
*   Provide clear usage examples demonstrating the override.
*   Mention the `.echo.json` file format and the backwards compatibility for reading `.json` files.

This completes the implementation of a flexible, predictable, and safer recording/replaying workflow. 