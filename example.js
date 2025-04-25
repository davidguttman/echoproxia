// example.js
const path = require('path');
const { createProxy } = require('./src'); // Assuming running from project root
const { OpenAI } = require('openai');

async function runExample(recordMode) {
  const recordingsDir = path.join(__dirname, '__example_recordings__');
  const targetUrl = 'https://openrouter.ai/api/v1'; // OpenRouter API base
  const sequenceName = 'openai-chat-mini-joke';

  console.log(`--- Running in ${recordMode ? 'RECORD' : 'REPLAY'} mode ---`);
  console.log(`Recordings dir: ${recordingsDir}`);
  console.log(`Target URL: ${targetUrl}`);
  console.log(`Sequence name: "${sequenceName}"`);

  let proxy = null;
  try {
    proxy = await createProxy({
      targetUrl: targetUrl,
      recordingsDir: recordingsDir,
      recordMode: recordMode,
      redactHeaders: ['authorization'], // Still good practice to redact auth
      port: 5050 // Using a known port simplifies client setup for the example
    });

    console.log(`Echoproxia proxy server running on: ${proxy.url}`);

    // Set the sequence name
    proxy.setSequence(sequenceName);
    console.log(`Recording sequence set to: "${sequenceName}"`);
    console.log(`Recordings will be stored under: ${path.join(recordingsDir, sequenceName)}`);

    // --- OpenAI Client Setup ---
    // IMPORTANT: In RECORD mode, this needs a REAL OpenRouter API key
    // set in the OPENROUTER_API_KEY environment variable to successfully
    // record the interaction with the actual OpenRouter API.
    // In REPLAY mode, the API key doesn't matter as no real call is made.
    const apiKey = process.env.OPENROUTER_API_KEY || 'DUMMY_KEY_WILL_FAIL_RECORDING';
    if (recordMode && apiKey === 'DUMMY_KEY_WILL_FAIL_RECORDING') {
        console.warn('\nWARNING: OPENROUTER_API_KEY environment variable not set. Recording will likely fail with a 401 error. Set the variable for a real recording.\n');
    }

    const openai = new OpenAI({
      baseURL: proxy.url, // Point the client to the Echoproxia proxy!
      apiKey: apiKey
      // No default headers needed for this basic chat completion example
    });

    console.log(`Attempting Chat Completion via proxy (${proxy.url})...`);
    try {
      // Make a chat completion request
      const completion = await openai.chat.completions.create({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'Tell me a short joke.' }],
      });

      // Log the response content
      const joke = completion.choices[0]?.message?.content;
      console.log('Successfully received chat completion (via proxy):');
      console.log(`Model Used: ${completion.model}`);
      console.log(`Response: ${joke}`);

    } catch (error) {
      console.error('API call failed:');
      // Log relevant parts of the error from the openai client
      if (error.response) {
         console.error(`Status: ${error.response.status}`);
         console.error(`Data: ${JSON.stringify(error.response.data)}`);
         // Specific check for expected failure in record mode without API key
         if (recordMode && error.response.status === 401) {
            console.error("--> This 401 Unauthorized is expected because OPENROUTER_API_KEY was not set for recording.");
         } else if (!recordMode) {
            // In replay mode, any error suggests a replay problem (missing file, exhausted sequence, etc.)
            console.error("--> Replay Error: Check recording exists and isn't exhausted.");
            throw new Error("Replay failed unexpectedly."); // Throw to indicate failure in replay
         } else {
             // Any other error in record mode might be a configuration issue
             console.error("--> Record Error: Unexpected error. Check targetUrl, API key validity, or network.");
         }
      } else {
         console.error(error.message);
         // If no response object, it might be a network issue or client-side problem
         if (!recordMode) {
            throw new Error("Replay failed unexpectedly (network or client error).");
         }
      }
      // Only let the script continue "successfully" in record mode if the error was the expected 401
      if (!(recordMode && error.response?.status === 401)) {
          process.exitCode = 1; // Indicate failure for unexpected errors
      }
    }

  } catch (error) {
    // Catch errors from createProxy or replay failures thrown above
    console.error('Failed during Echoproxia example run:', error.message);
    process.exitCode = 1; // Set exit code to indicate failure
  } finally {
    if (proxy) {
      console.log('Stopping Echoproxia server...');
      await proxy.stop();
      console.log('Server stopped.');
    }
    console.log(`Exiting with code: ${process.exitCode || 0}`);
  }
}

// --- Run Record/Replay Example ---
(async () => {
  process.exitCode = 0; // Reset exit code for the run
  console.log("===== PREPARING EXAMPLE RUN ======");
  // Use the correct sequence name for clearing
  const sequenceDir = path.join(__dirname, '__example_recordings__', 'openai-chat-mini-joke');
  try {
    // Only clear the specific sequence directory for this test
    await require('fs').promises.rm(sequenceDir, { recursive: true, force: true });
    console.log(`Cleared specific sequence directory: ${sequenceDir}`);
  } catch (err) {
    if (err.code !== 'ENOENT') { // Log error only if it's not "directory not found"
        console.error(`Error clearing directory ${sequenceDir}:`, err);
        process.exitCode = 1; // Fail early if cleanup fails unexpectedly
        return;
    } else {
        console.log(`Sequence directory did not exist (normal for first run): ${sequenceDir}`);
    }
  }

  if (process.exitCode !== 0) return; // Don't run if cleanup failed

  console.log("===== RECORD MODE RUN ======");
  await runExample(true); // Run in record mode

  // Check if record mode failed unexpectedly before attempting replay
  if (process.exitCode !== 0) {
      console.error("Record mode failed unexpectedly. Skipping replay.");
      return;
  }

  console.log("===== REPLAY MODE RUN ======");
  await runExample(false); // Run in replay mode

})();
