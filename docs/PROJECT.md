# Project Status

* Updated README.md to clarify the behavior of record mode when recordings already exist (interactions are appended).
* ~~Updated `tutorials/04-plaintext-body.md` to correctly handle compressed (gzip/deflate) response bodies when generating `bodyPlainText`.~~ (Tutorial was already updated, the code was the issue).
* Fixed bug in `src/index.js` where `includePlainTextBody` did not handle compressed (gzip/deflate) response bodies, causing compressed data to be saved as plaintext. The fix involves using `zlib` for decompression before UTF-8 decoding.
* Standardized recording format in `src/index.js` to use `response.body` (base64 string of full original response) instead of `response.chunks` array.
* Updated tests in `test/proxy.test.js` to align with the `response.body` change and fix related errors.
* Fixed critical bug in `src/index.js` where requests in replay mode would incorrectly fall through to the proxy/record logic after replay finished successfully. Added a `return` statement to prevent this leak.
* Updated replay test setups (`Backwards Compatibility`, `Override` tests) in `test/proxy.test.js` to create recordings using the correct `response.body` format instead of the old `response.chunks` format.
* Added new test `Replay Mode: should NOT leak request to target on successful replay` to `test/proxy.test.js` to specifically cover the replay fallthrough bug (although demonstrating the failure proved difficult due to async timing).

