import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// react-router's data router (createBrowserRouter) builds an internal `Request`
// for every navigation, carrying an AbortSignal from an AbortController it creates
// itself. In the jsdom test environment, `AbortController`/`AbortSignal` come from
// jsdom, while `Request` comes from Node's native fetch implementation — which
// rejects a jsdom AbortSignal as "not an instance of AbortSignal". These internal
// Request objects are never used for real network I/O (fetch is mocked in every
// test), so dropping the signal here is safe and keeps the two realms from
// colliding.
if (typeof globalThis.Request !== 'undefined') {
  const NativeRequest = globalThis.Request;
  class TestRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init: RequestInit = {}) {
      const rest = { ...init };
      delete rest.signal;
      super(input, rest);
    }
  }
  globalThis.Request = TestRequest as typeof Request;
}
