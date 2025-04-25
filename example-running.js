// example.js
const path = require('path');
const { createProxy } = require('./src'); // Assuming running from project root

async function runExample() {
  const recordingsDir = path.join(__dirname, '__example_recordings__');
  const targetUrl = 'https://openrouter.ai'; // Example target

  console.log(`Starting Echoproxia in ${process.env.RECORD_MODE === 'true' ? 'record' : 'replay'} mode...`);
  console.log(`Recordings will be saved to: ${recordingsDir}`);
  console.log(`Target URL: ${targetUrl}`);

  try {
    const proxy = await createProxy({
      targetUrl: targetUrl,
      recordingsDir: recordingsDir,
      recordMode: process.env.RECORD_MODE === 'true',
      // Optional: Add headers to redact if needed
      redactHeaders: ['authorization', 'cookie']
    });

    console.log(`Echoproxia proxy server running on: ${proxy.url}`);

    // Set a sequence name for this recording session
    const sequenceName = 'my-first-recording';
    proxy.setSequence(sequenceName);
    console.log(`Recording sequence set to: "${sequenceName}"`);
    console.log(`Recordings will be stored under: ${path.join(recordingsDir, sequenceName)}`);

    console.log('\nProxy is running. Send requests to the proxy URL to record them.');
    console.log(`Example: curl ${proxy.url}/get`);
    console.log('Press Ctrl+C to stop the server.');

    // Keep the server running indefinitely until manually stopped (e.g., Ctrl+C)
    // We don't call proxy.stop() here.

  } catch (error) {
    console.error('Failed to start Echoproxia:', error);
    process.exit(1);
  }
}

runExample();
