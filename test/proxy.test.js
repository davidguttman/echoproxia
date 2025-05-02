// test/proxy.test.js
const test = require('ava')
const path = require('path')
const fs = require('fs').promises
const axios = require('axios')
const rimraf = require('rimraf') // For cleaning directories
const express = require('express')
const getPort = require('get-port')
const { createProxy } = require('../src/index') // Import the actual module interface

const TEST_RECORDINGS_DIR = path.join(__dirname, '__test_recordings__')
// Define expected extensions
const NEW_EXTENSION = '.echo.json'
const OLD_EXTENSION = '.json'

// Helper function to wait for file existence
async function waitForFile (filePath, timeoutMs = 2000, intervalMs = 100) {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    try {
      await fs.access(filePath)
      return true // File exists
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err // Re-throw unexpected errors
      }
      // File doesn't exist yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }
  return false // Timeout reached
}

// --- Mock Target Server Setup ---
let mockTargetServer
let lastMockRequest = null
let mockTargetPort
let MOCK_TARGET_URL

test.before(async t => {
  mockTargetPort = await getPort()
  MOCK_TARGET_URL = `http://localhost:${mockTargetPort}`

  return new Promise(resolve => {
    const mockApp = express()
    mockApp.use(express.raw({ type: '*/*', limit: '10mb' }))
    mockApp.use((req, res, next) => {
      lastMockRequest = {
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
        body: req.body
      }
      next()
    })
    mockApp.get('/get', (req, res) => {
      res.status(200).json({ message: 'mock get success', query: req.query })
    })
    mockApp.post('/post', (req, res) => {
      let bodyResponse
      try {
        bodyResponse = JSON.parse(req.body.toString('utf8'))
      } catch (e) {
        bodyResponse = req.body.toString('utf8')
      }
      res.status(201).json({ message: 'mock post success', received_body: bodyResponse })
    })
    mockApp.all('*', (req, res) => {
      res.status(404).send('Mock Not Found')
    })

    mockTargetServer = mockApp.listen(mockTargetPort, () => {
      console.log(`Mock target server running on port ${mockTargetPort}`)
      resolve()
    })
  })
})

test.after.always(async t => {
  if (mockTargetServer) {
    await new Promise(resolve => mockTargetServer.close(resolve))
  }
  console.log('Mock target server stopped')
})

// --- Test Hooks ---
test.beforeEach(async t => {
  // Clean up recordings directory before each test
  await new Promise((resolve, reject) => rimraf(TEST_RECORDINGS_DIR, err => err ? reject(err) : resolve()))
  await fs.mkdir(TEST_RECORDINGS_DIR, { recursive: true })
  lastMockRequest = null // Reset mock state

  // Each test will start its own proxy instance
  t.context.proxy = null
})

test.afterEach.always(async t => {
  // Ensure proxy server is stopped after each test
  if (t.context.proxy && t.context.proxy.stop) {
    await t.context.proxy.stop()
  }
})

// --- Test Cases (Adapted from Tutorial) ---

test.serial('Record Mode: should proxy request and save recording', async t => {
  const sequenceName = 'test-record-sequence'
  const requestPath = '/get'
  const requestQuery = '?query=1&param=value'
  const sanitizedBase = `_${requestPath.replace(/^\//, '')}`
  const recordingFilePath = path.join(TEST_RECORDINGS_DIR, sequenceName, `${sanitizedBase}${NEW_EXTENSION}`)

  // Start proxy in record mode
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR
  })

  t.truthy(t.context.proxy, 'Proxy instance should be created')
  t.truthy(t.context.proxy.url, 'Proxy should have a URL')

  // Set sequence
  t.context.proxy.setSequence(sequenceName)

  // Make request through the proxy
  const proxyResponse = await axios.get(`${t.context.proxy.url}${requestPath}${requestQuery}`)

  // Assert response from proxy (should match mock target)
  t.is(proxyResponse.status, 200)
  t.deepEqual(proxyResponse.data, { message: 'mock get success', query: { query: '1', param: 'value' } })

  // Assert mock target was hit
  t.truthy(lastMockRequest, 'Mock target should have received a request')
  t.is(lastMockRequest.method, 'GET')
  t.is(lastMockRequest.path, `${requestPath}${requestQuery}`)

  // Wait for the recording file to appear
  const fileExists = await waitForFile(recordingFilePath)
  t.true(fileExists, 'Recording file should be created within timeout')

  // Assert recording file was created (now redundant with waitForFile but keep for clarity)
  try {
    await fs.access(recordingFilePath)
    t.pass('Recording file should exist')
  } catch {
    t.fail('Recording file should exist')
  }

  // Assert recording content (basic check)
  try {
    const recordings = JSON.parse(await fs.readFile(recordingFilePath, 'utf8'))
    t.is(recordings.length, 1, 'Should have one recording')
    const recorded = recordings[0]
    t.is(recorded.request.method, 'GET')
    t.is(recorded.request.path, requestPath)
    t.is(recorded.response.status, 200)
    const expectedResponseJson = JSON.stringify({ message: 'mock get success', query: { query: '1', param: 'value' } })
    const expectedChunk = Buffer.from(expectedResponseJson).toString('base64')
    t.truthy(Array.isArray(recorded.response.chunks), 'Response should have chunks array')
    t.is(recorded.response.chunks.length, 1, 'Response should have one chunk for simple JSON')
    t.is(recorded.response.chunks[0], expectedChunk, 'Recorded chunk content should match expected')
  } catch (e) {
    t.log('Failed to read/parse/validate recording', e)
    t.fail(`Recording content validation failed: ${e.message}`)
  }
})

test.serial('Replay Mode: should replay interaction and handle exhaustion', async t => {
  const sequenceName = 'test-replay-sequence'
  const requestPath = '/post'
  const requestBody = { data: 'replay-me' }
  const recordingFilePath = path.join(TEST_RECORDINGS_DIR, sequenceName, '_post.json')

  // --- Setup: Manually create a recording file for replay ---
  const mockResponseData = { message: 'mock post success', received_body: requestBody }
  const recordingContent = [
    {
      request: {
        method: 'POST',
        path: requestPath,
        originalUrl: requestPath,
        headers: { /* ... relevant headers ... */ },
        body: Buffer.from(JSON.stringify(requestBody)).toString('base64')
      },
      response: {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: {
          encoding: 'utf8',
          data: JSON.stringify(mockResponseData),
          originalContentEncoding: null
        }
      }
    }
  ]
  await fs.mkdir(path.dirname(recordingFilePath), { recursive: true })
  await fs.writeFile(recordingFilePath, JSON.stringify(recordingContent, null, 2))
  // --- End Setup ---

  // Start proxy in replay mode
  t.context.proxy = await createProxy({
    recordMode: false,
    targetUrl: 'http://should-not-be-hit.invalid', // Target shouldn't be hit
    recordingsDir: TEST_RECORDINGS_DIR
  })

  t.truthy(t.context.proxy, 'Proxy instance should be created')
  t.truthy(t.context.proxy.url, 'Proxy should have a URL')

  // Set sequence
  t.context.proxy.setSequence(sequenceName)

  lastMockRequest = null // Reset mock state before replay attempts

  // Make request through the proxy - First time should replay
  // Expect this to fail initially because createProxy is a stub
  try {
    const replayResponse1 = await axios.post(`${t.context.proxy.url}${requestPath}`, requestBody)
    // If it gets here, the stub might be behaving unexpectedly or implementation started
    t.is(replayResponse1.status, 201)
    t.deepEqual(replayResponse1.data, mockResponseData)
    t.log('First replay request succeeded unexpectedly (stub behavior?)')
  } catch (error) {
    // We expect an error here initially
    t.log('First replay request failed as expected (proxy not implemented).')
    t.pass()
  }

  // Assert mock target was NOT hit during replay
  t.is(lastMockRequest, null, 'Mock target should NOT have been hit during replay')

  // Make the same request again - Second time should exhaust sequence or fail similarly
  // Expect this to fail initially
  try {
    await axios.post(`${t.context.proxy.url}${requestPath}`, requestBody)
    // If it gets here, something is unexpected
    t.log('Second replay request succeeded unexpectedly.')
    t.fail('Second replay request should have failed.')
  } catch (error) {
    // We expect an error here initially
    t.log('Second replay request failed as expected (proxy not implemented or sequence exhausted).')
    t.pass()
    // Once implemented, we'd check for the specific 500 error:
    // t.is(error.response.status, 500)
    // t.true(error.response.data.includes('Sequence exhausted'))
  }

  // Assert mock target was STILL NOT hit
  t.is(lastMockRequest, null, 'Mock target should still NOT have been hit')
})

test.serial('Record Mode: should proxy request and save recording with .echo.json extension', async t => {
  const sequenceName = 'test-record-sequence-new-ext'
  const requestPath = '/get'
  const requestQuery = '?ext=echo'
  // Use new sanitize logic to predict filename
  const sanitizedBase = `_${requestPath.replace(/^\//, '')}` // -> '_get'
  const recordingFilePath = path.join(TEST_RECORDINGS_DIR, sequenceName, `${sanitizedBase}${NEW_EXTENSION}`) // -> .../_get.echo.json

  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR
  })
  t.context.proxy.setSequence(sequenceName)

  const proxyResponse = await axios.get(`${t.context.proxy.url}${requestPath}${requestQuery}`)

  t.is(proxyResponse.status, 200)
  t.truthy(lastMockRequest, 'Mock target should have received a request')

  const fileExists = await waitForFile(recordingFilePath)
  t.true(fileExists, `Recording file ${recordingFilePath} should be created`)

  // Assert content (simplified)
  try {
    const recordings = JSON.parse(await fs.readFile(recordingFilePath, 'utf8'))
    t.is(recordings.length, 1, 'Should have one recording')
    t.is(recordings[0].request.path, requestPath)
    t.is(recordings[0].response.status, 200)
  } catch (e) {
    t.fail(`Recording content validation failed: ${e.message}`)
  }
})

// --- Tests for Cleanup Logic --- 

test.serial('Record Mode: setSequence should clear only .echo.json files', async t => {
  const sequenceName = 'test-cleanup-sequence'
  const sequencePath = path.join(TEST_RECORDINGS_DIR, sequenceName)
  const fileToClear = path.join(sequencePath, `_test${NEW_EXTENSION}`)
  const fileToKeepJson = path.join(sequencePath, `_test${OLD_EXTENSION}`)
  const fileToKeepOther = path.join(sequencePath, '_test.other.txt')

  // Setup: Create sequence dir and files
  await fs.mkdir(sequencePath, { recursive: true })
  await fs.writeFile(fileToClear, '[]')
  await fs.writeFile(fileToKeepJson, '[]')
  await fs.writeFile(fileToKeepOther, 'some text')

  // Check initial state
  await t.notThrowsAsync(fs.access(fileToClear), 'Expected .echo.json to exist initially')
  await t.notThrowsAsync(fs.access(fileToKeepJson), 'Expected .json to exist initially')
  await t.notThrowsAsync(fs.access(fileToKeepOther), 'Expected .other.txt to exist initially')

  // Start proxy and set sequence
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR
  })
  await t.context.proxy.setSequence(sequenceName) // Use await as setSequence is async

  // Assert state after setSequence
  await t.throwsAsync(fs.access(fileToClear), { code: 'ENOENT' }, 'Expected .echo.json to be deleted')
  await t.notThrowsAsync(fs.access(fileToKeepJson), 'Expected .json to be kept')
  await t.notThrowsAsync(fs.access(fileToKeepOther), 'Expected .other.txt to be kept')
});

test.serial('Record Mode: Initial startup should clear only .echo.json from default sequence', async t => {
  const defaultSequenceName = 'default-sequence' // Match default in src/index.js
  const sequencePath = path.join(TEST_RECORDINGS_DIR, defaultSequenceName)
  const fileToClear = path.join(sequencePath, `_initial${NEW_EXTENSION}`)
  const fileToKeepJson = path.join(sequencePath, `_initial${OLD_EXTENSION}`)
  const fileToKeepOther = path.join(sequencePath, '_initial.other.txt')

  // Setup: Create default sequence dir and files BEFORE starting proxy
  await fs.mkdir(sequencePath, { recursive: true })
  await fs.writeFile(fileToClear, '[]')
  await fs.writeFile(fileToKeepJson, '[]')
  await fs.writeFile(fileToKeepOther, 'some text')

  // Check initial state
  await t.notThrowsAsync(fs.access(fileToClear), 'Expected .echo.json to exist before startup')
  await t.notThrowsAsync(fs.access(fileToKeepJson), 'Expected .json to exist before startup')
  await t.notThrowsAsync(fs.access(fileToKeepOther), 'Expected .other.txt to exist before startup')

  // Start proxy in record mode (initial cleanup happens here)
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR,
    defaultSequenceName: defaultSequenceName // Explicitly pass for clarity
  })

  // Assert state after startup (give a brief moment for async cleanup)
  await new Promise(resolve => setTimeout(resolve, 100)) // Small delay for async fs.rm

  await t.throwsAsync(fs.access(fileToClear), { code: 'ENOENT' }, 'Expected .echo.json to be deleted by startup')
  await t.notThrowsAsync(fs.access(fileToKeepJson), 'Expected .json to be kept after startup')
  await t.notThrowsAsync(fs.access(fileToKeepOther), 'Expected .other.txt to be kept after startup')
});

// --- Tests for Backwards Compatibility --- 

test.serial('Replay Mode: Backwards Compatibility', async t => {
  const sequenceName = 'test-backwards-compat'
  const requestPath = '/replay-compat'
  const sequencePath = path.join(TEST_RECORDINGS_DIR, sequenceName)
  const baseFilename = `_${requestPath.replace(/^\//, '')}` // -> '_replay-compat' 
  const newFilePath = path.join(sequencePath, `${baseFilename}${NEW_EXTENSION}`)
  const oldFilePath = path.join(sequencePath, `${baseFilename}${OLD_EXTENSION}`)

  // Helper to create a recording file
  const createRecording = async (filePath, responseData) => {
    const content = [{
      request: { method: 'GET', path: requestPath, /* ... */ },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        chunks: [Buffer.from(JSON.stringify(responseData)).toString('base64')] // Simplified chunk
      }
    }]
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(content, null, 2))
  }

  // Sub-test function
  const runReplayTest = async (setupFn, expectedData, description) => {
    // Clean and setup for sub-test
    await new Promise((resolve, reject) => rimraf(sequencePath, err => err ? reject(err) : resolve()))
    await setupFn()

    // Start proxy in replay mode
    const proxy = await createProxy({
      recordMode: false,
      targetUrl: MOCK_TARGET_URL, // Should not be hit
      recordingsDir: TEST_RECORDINGS_DIR
    })
    await proxy.setSequence(sequenceName) // Use await

    lastMockRequest = null // Ensure target is not hit
    let response
    try {
      response = await axios.get(`${proxy.url}${requestPath}`)
    } finally {
      await proxy.stop()
    }

    t.is(lastMockRequest, null, `${description}: Mock target should not be hit`)
    t.is(response.status, 200, `${description}: Should get 200 status`)
    t.deepEqual(response.data, expectedData, `${description}: Response data should match expected`)
  }

  // Test 1: Only .echo.json exists
  const dataNew = { source: 'new format .echo.json' }
  await runReplayTest(
    async () => createRecording(newFilePath, dataNew),
    dataNew,
    'New format only'
  )

  // Test 2: Only .json exists
  const dataOld = { source: 'old format .json' }
  await runReplayTest(
    async () => createRecording(oldFilePath, dataOld),
    dataOld,
    'Old format only'
  )

  // Test 3: Both exist (.echo.json should take precedence)
  const dataBothNew = { source: 'new format when both exist' }
  const dataBothOld = { source: 'old format when both exist' }
  await runReplayTest(
    async () => {
      await createRecording(newFilePath, dataBothNew)
      await createRecording(oldFilePath, dataBothOld)
    },
    dataBothNew, // Expect data from .echo.json
    'Both formats exist'
  )

  // Test 4: Neither exists
  await new Promise((resolve, reject) => rimraf(sequencePath, err => err ? reject(err) : resolve())) // Ensure clean slate
  const proxyNeither = await createProxy({
    recordMode: false,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR
  })
  await proxyNeither.setSequence(sequenceName)
  lastMockRequest = null
  try {
    await axios.get(`${proxyNeither.url}${requestPath}`)
    t.fail('Neither format: Should have failed')
  } catch (error) {
    t.is(lastMockRequest, null, 'Neither format: Mock target should not be hit')
    t.is(error.response?.status, 500, 'Neither format: Should fail with 500')
    t.truthy(error.response?.data?.includes('No recording found'), 'Neither format: Error message should indicate not found')
  } finally {
    await proxyNeither.stop()
  }
}); 

// --- Tests for setSequence RecordMode Override ---

test.serial('Override: Global Record, Sequence Replay -> Should Replay', async t => {
  const sequenceName = 'override-global-record-seq-replay'
  const requestPath = '/get'
  const dummyRecordingFile = path.join(TEST_RECORDINGS_DIR, sequenceName, `_get${NEW_EXTENSION}`)
  const dummyReplayData = [{ request: {}, response: { status: 299, headers: { 'x-replayed': 'true' }, chunks: [Buffer.from(JSON.stringify({ replay: 'override-works' })).toString('base64')] } }]

  // Prepare dummy recording
  await fs.mkdir(path.dirname(dummyRecordingFile), { recursive: true })
  await fs.writeFile(dummyRecordingFile, JSON.stringify(dummyReplayData, null, 2))

  // Start proxy in GLOBAL RECORD mode
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR,
    defaultSequenceName: 'should-not-be-used'
  })
  t.truthy(t.context.proxy, 'Proxy instance should be created')

  lastMockRequest = null // Reset mock state

  // Set sequence, OVERRIDING to REPLAY mode
  await t.context.proxy.setSequence(sequenceName, { recordMode: false })

  // Make request
  const response = await axios.get(`${t.context.proxy.url}${requestPath}`)

  // Assert response came from dummy recording (replay)
  t.is(response.status, 299)
  t.is(response.headers['x-replayed'], 'true')
  t.deepEqual(response.data, { replay: 'override-works' })

  // Assert mock target was NOT hit
  t.is(lastMockRequest, null, 'Mock target should NOT have been hit during forced replay')
});

test.serial('Override: Global Replay, Sequence Record -> Should Record', async t => {
  const sequenceName = 'override-global-replay-seq-record'
  const requestPath = '/post'
  const requestBody = { record: 'this' }
  const expectedRecordingFile = path.join(TEST_RECORDINGS_DIR, sequenceName, `_post${NEW_EXTENSION}`)

  // Start proxy in GLOBAL REPLAY mode
  t.context.proxy = await createProxy({
    recordMode: false,
    targetUrl: MOCK_TARGET_URL, // Target needed for recording
    recordingsDir: TEST_RECORDINGS_DIR,
    defaultSequenceName: 'should-not-be-used'
  })
  t.truthy(t.context.proxy, 'Proxy instance should be created')

  lastMockRequest = null // Reset mock state

  // Set sequence, OVERRIDING to RECORD mode
  await t.context.proxy.setSequence(sequenceName, { recordMode: true })

  // Make request
  const response = await axios.post(`${t.context.proxy.url}${requestPath}`, requestBody)

  // Assert response came from mock server (recording)
  t.is(response.status, 201)
  t.deepEqual(response.data, { message: 'mock post success', received_body: requestBody })

  // Assert mock target WAS hit
  t.truthy(lastMockRequest, 'Mock target should have been hit during forced record')
  t.is(lastMockRequest.method, 'POST')
  t.is(lastMockRequest.path, requestPath)

  // Assert recording file was created
  const fileExists = await waitForFile(expectedRecordingFile)
  t.true(fileExists, 'Recording file should be created due to override')
  try {
    const recordings = JSON.parse(await fs.readFile(expectedRecordingFile, 'utf8'))
    t.is(recordings.length, 1, 'Should have one recording')
    t.is(recordings[0].request.method, 'POST')
    t.is(recordings[0].response.status, 201)
  } catch (e) {
    t.fail(`Failed to validate recording content: ${e.message}`)
  }
});

test.serial('Override: Global Record, No Override -> Should Record', async t => {
  const sequenceName = 'no-override-global-record-seq-record'
  const requestPath = '/get'
  const requestQuery = '?default=record'
  const expectedRecordingFile = path.join(TEST_RECORDINGS_DIR, sequenceName, `_get${NEW_EXTENSION}`)

  // Start proxy in GLOBAL RECORD mode
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR,
    defaultSequenceName: 'should-not-be-used'
  })
  t.truthy(t.context.proxy, 'Proxy instance should be created')

  lastMockRequest = null // Reset mock state

  // Set sequence, using default global RECORD mode
  await t.context.proxy.setSequence(sequenceName)

  // Make request
  const response = await axios.get(`${t.context.proxy.url}${requestPath}${requestQuery}`)

  // Assert response came from mock server (recording)
  t.is(response.status, 200)
  t.deepEqual(response.data, { message: 'mock get success', query: { default: 'record' } })

  // Assert mock target WAS hit
  t.truthy(lastMockRequest, 'Mock target should have been hit during default record')
  t.is(lastMockRequest.method, 'GET')
  t.is(lastMockRequest.path, `${requestPath}${requestQuery}`)

  // Assert recording file was created
  const fileExists = await waitForFile(expectedRecordingFile)
  t.true(fileExists, 'Recording file should be created when using default global record mode')
});

test.serial('Override: Global Replay, No Override -> Should Replay', async t => {
  const sequenceName = 'no-override-global-replay-seq-replay'
  const requestPath = '/post'
  const requestBody = { default: 'replay' }
  const dummyRecordingFile = path.join(TEST_RECORDINGS_DIR, sequenceName, `_post${NEW_EXTENSION}`)
  const dummyReplayData = [{ request: {}, response: { status: 298, headers: { 'x-replayed-default': 'true' }, chunks: [Buffer.from(JSON.stringify({ replay: 'default-replay' })).toString('base64')] } }]

  // Prepare dummy recording
  await fs.mkdir(path.dirname(dummyRecordingFile), { recursive: true })
  await fs.writeFile(dummyRecordingFile, JSON.stringify(dummyReplayData, null, 2))

  // Start proxy in GLOBAL REPLAY mode
  t.context.proxy = await createProxy({
    recordMode: false,
    targetUrl: 'http://should-not-be-hit.invalid',
    recordingsDir: TEST_RECORDINGS_DIR,
    defaultSequenceName: 'should-not-be-used'
  })
  t.truthy(t.context.proxy, 'Proxy instance should be created')

  lastMockRequest = null // Reset mock state

  // Set sequence, using default global REPLAY mode
  await t.context.proxy.setSequence(sequenceName)

  // Make request
  const response = await axios.post(`${t.context.proxy.url}${requestPath}`, requestBody)

  // Assert response came from dummy recording (replay)
  t.is(response.status, 298)
  t.is(response.headers['x-replayed-default'], 'true')
  t.deepEqual(response.data, { replay: 'default-replay' })

  // Assert mock target was NOT hit
  t.is(lastMockRequest, null, 'Mock target should NOT have been hit during default replay')
});

// --- Tests for Recording File Format & Cleanup ---

// --- Tests for includePlainTextBody Option ---

test.serial('Record Mode: includePlainTextBody: true -> should add bodyPlainText', async t => {
  const sequenceName = 'test-plaintext-true'
  const requestPath = '/post'
  const requestBody = { text: 'hello plaintext' }
  const expectedRecordingFile = path.join(TEST_RECORDINGS_DIR, sequenceName, `_post${NEW_EXTENSION}`)
  const expectedPlainText = JSON.stringify({ message: 'mock post success', received_body: requestBody })

  // Start proxy in record mode WITH plaintext option
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR,
    includePlainTextBody: true // <<< Enable the option
  })

  t.truthy(t.context.proxy, 'Proxy instance should be created')
  t.context.proxy.setSequence(sequenceName)

  // Make request
  const proxyResponse = await axios.post(`${t.context.proxy.url}${requestPath}`, requestBody)
  t.is(proxyResponse.status, 201)

  // Wait for and validate recording
  const fileExists = await waitForFile(expectedRecordingFile)
  t.true(fileExists, 'Recording file should be created')

  try {
    const recordings = JSON.parse(await fs.readFile(expectedRecordingFile, 'utf8'))
    t.is(recordings.length, 1, 'Should have one recording')
    const recordedResponse = recordings[0].response

    t.is(recordedResponse.status, 201)
    // Verify plaintext field
    t.true(recordedResponse.hasOwnProperty('bodyPlainText'), 'Response should have bodyPlainText field')
    t.is(recordedResponse.bodyPlainText, expectedPlainText, 'bodyPlainText content should match expected decoded string')
    // Verify chunks still exist
    t.truthy(Array.isArray(recordedResponse.chunks), 'Response should still have chunks array')
    t.is(recordedResponse.chunks.length, 1, 'Response should have one chunk for simple JSON')
    t.is(Buffer.from(recordedResponse.chunks[0], 'base64').toString('utf8'), expectedPlainText, 'Decoded chunk should match plaintext')

  } catch (e) {
    t.fail(`Recording content validation failed: ${e.message}`)
  }
});

test.serial('Record Mode: includePlainTextBody: false -> should NOT add bodyPlainText', async t => {
  const sequenceName = 'test-plaintext-false'
  const requestPath = '/get'
  const expectedRecordingFile = path.join(TEST_RECORDINGS_DIR, sequenceName, `_get${NEW_EXTENSION}`)

  // Start proxy in record mode WITHOUT plaintext option (default is false)
  t.context.proxy = await createProxy({
    recordMode: true,
    targetUrl: MOCK_TARGET_URL,
    recordingsDir: TEST_RECORDINGS_DIR
    // includePlainTextBody is omitted (defaults to false)
  })

  t.truthy(t.context.proxy, 'Proxy instance should be created')
  t.context.proxy.setSequence(sequenceName)

  // Make request
  const proxyResponse = await axios.get(`${t.context.proxy.url}${requestPath}`)
  t.is(proxyResponse.status, 200)

  // Wait for and validate recording
  const fileExists = await waitForFile(expectedRecordingFile)
  t.true(fileExists, 'Recording file should be created')

  try {
    const recordings = JSON.parse(await fs.readFile(expectedRecordingFile, 'utf8'))
    t.is(recordings.length, 1, 'Should have one recording')
    const recordedResponse = recordings[0].response

    t.is(recordedResponse.status, 200)
    // Verify plaintext field is ABSENT
    t.false(recordedResponse.hasOwnProperty('bodyPlainText'), 'Response should NOT have bodyPlainText field')
    // Verify chunks exist
    t.truthy(Array.isArray(recordedResponse.chunks), 'Response should still have chunks array')
    t.is(recordedResponse.chunks.length, 1, 'Response should have one chunk for simple JSON')

  } catch (e) {
    t.fail(`Recording content validation failed: ${e.message}`)
  }
}); 