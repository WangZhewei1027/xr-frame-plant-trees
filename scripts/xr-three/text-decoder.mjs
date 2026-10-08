import { AbortController as PolyfillAbortController } from 'abort-controller';
// Lexically injected by esbuild; does not modify globalThis or other pages.
// The lab reads valid UTF-8 GLB JSON. Streaming / other encodings are unsupported.
class LabUtf8Decoder {
  constructor(encoding = 'utf-8') {
    if (!/^utf-?8$/i.test(encoding)) throw new Error('Lab decoder only supports UTF-8');
  }
  decode(input = new Uint8Array()) {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let encoded = '';
    for (let i = 0; i < bytes.length; i++) encoded += '%' + bytes[i].toString(16).padStart(2, '0');
    return decodeURIComponent(encoded).replace(/^\uFEFF/, '');
  }
}
export const TextDecoder = typeof globalThis.TextDecoder === 'function'
  ? globalThis.TextDecoder : LabUtf8Decoder;
export const AbortController = typeof globalThis.AbortController === 'function'
  ? globalThis.AbortController : PolyfillAbortController;
