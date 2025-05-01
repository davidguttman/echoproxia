# Tutorial: Safer Recordings with Backwards Compatibility

This tutorial builds upon the basic Echoproxia proxy (potentially from `01-building-the-proxy.md`) and modifies the recording behavior for improved safety and predictability.

We will:

*   Adopt a specific file extension for new recordings: `.echo.json`.
*   Change the recording behavior to clear *only* existing `*.echo.json` files when activating a sequence in record mode (instead of appending or deleting the whole directory).
*   Add backwards compatibility to allow replaying from older `.json` files if the new `.echo.json` format isn't found.

## Prerequisites

*   An existing Echoproxia implementation (e.g., `src/index.js`).
*   Familiarity with the core concepts: `recordMode`, `recordingsDir`, `setSequence`, `sanitizeFilename`, `writeRecording`, `handleReplay`.

## Goal

New recordings use `.echo.json`. Activating record mode clears only `.echo.json` files for the sequence. Replay mode reads `.echo.json` first, then falls back to `.json`.

## Steps

1.  **Update Filename Convention (Writing):**
    Modify your `sanitizeFilename` helper function to *always* append `.echo.json`.

    ```javascript
    // In src/index.js (or your implementation file)
    function sanitizeFilename (filePath) {
      // Replace slashes and invalid chars; ensure it starts with '_'
      const baseName = `_${filePath.replace(/^\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
      // Append the specific extension
      return `${baseName}.echo.json`;
    }
    ```
    *The `writeRecording` function, assuming it uses `sanitizeFilename`, will now automatically write `.echo.json` files.*

2.  **Modify `setSequence` Function (Targeted Deletion):**
    Update the `setSequence` function (likely returned by `createProxy`). When in record mode, it should read the sequence directory and unlink only files matching `*.echo.json`.

    ```javascript
    // Inside createProxy function, in the returned object's setSequence method:
    setSequence: async (sequenceName /*, options... see next tutorial */) => {
      // Assume currentRecordMode holds the global mode (true=record, false=replay)
      const effectiveMode = currentRecordMode; // This will be enhanced in the next tutorial

      // --- Sequence Recording Cleanup Logic --- 
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

      // Original logic: Set name, reset counters
      currentSequenceName = sequenceName;
      logInfo(`Sequence set to: ${currentSequenceName}`);
      replayCounters[currentSequenceName] = {}; 
    },
    ```

3.  **Modify `handleReplay` Function (Backwards Compatibility Reading):**
    Update the `handleReplay` function to try reading the new `.echo.json` format first, falling back to the old `.json` format.

    ```javascript
    // Inside the handleReplay function:
    async function handleReplay (req, res, /* { other params } */ ) {
      // 1. Construct NEW filename (.echo.json)
      const recordingFilenameNew = sanitizeFilename(req.path); // Uses new .echo.json convention
      const recordingFilepathNew = path.join(currentRecordingsDir, currentSequenceName, recordingFilenameNew);

      // 2. Construct OLD filename (.json)
      const recordingFilenameOld = recordingFilenameNew.replace(/\.echo\.json$/, '.json');
      const recordingFilepathOld = path.join(currentRecordingsDir, currentSequenceName, recordingFilenameOld);

      let sequenceRecordings = [];
      let usedFilepath = '';

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
      // Ensure replay counter logic uses the 'usedFilepath' variable as its key
      if (!replayCounters[currentSequenceName]) {
         replayCounters[currentSequenceName] = {};
      }
      const sequenceReplayState = replayCounters[currentSequenceName];
      const currentIndex = sequenceReplayState[usedFilepath] || 0; // Keyed by actual file used

      if (currentIndex >= sequenceRecordings.length) {
         // ... (handle sequence exhausted error) ...
         return false;
      }

      const { response: recordedResponse } = sequenceRecordings[currentIndex];
      sequenceReplayState[usedFilepath] = currentIndex + 1; // Update counter using correct key

      // ... (rest of logic to stream response) ...

      logInfo(`Replayed interaction ${currentIndex + 1}/${sequenceRecordings.length} from ${usedFilepath}`);
      return true; // Indicate success
    }
    ```
    *Make sure your `readRecordings` helper handles file-not-found errors gracefully (e.g., returns `[]`).*

4.  **Handle Initial State (Targeted Deletion):**
    Apply the same targeted `*.echo.json` deletion logic to the initial cleanup step within `createProxy` if it starts in record mode.

    ```javascript
    // Inside createProxy, before starting the server
    if (currentRecordMode) { // Check the global record mode state
      const initialSequencePath = path.join(currentRecordingsDir, currentSequenceName); // Default sequence
      logInfo(`Record mode active: Clearing initial *.echo.json files in: ${initialSequencePath}`);
      // Use an async IIFE for non-blocking cleanup
      (async () => {
        try {
          const filenames = await fs.readdir(initialSequencePath);
          for (const filename of filenames) {
            if (filename.endsWith('.echo.json')) {
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
          }
        }
      })(); // Fire-and-forget
    }
    ```

## Outcome

Echoproxia now writes `.echo.json` files, safely clears only these files when activating a sequence in record mode, and can replay from both new `.echo.json` and older `.json` files.

## Next Steps

The next tutorial (`03-per-sequence-mode-override.md`) will cover how to allow overriding the global record/replay mode for specific sequences. 