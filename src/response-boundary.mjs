// Upstream services are external input too. Stop reading as soon as their
// response exceeds the budget, before parsing or passing it to the decoder.
export async function readJsonResponse(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid response limit');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Upstream JSON response exceeded the review limit');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new Error('Upstream JSON response exceeded the review limit');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length).toString('utf8'));
  }
  // Tests sometimes use minimal response doubles without a stream.
  if (typeof response.text === 'function') {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Upstream JSON response exceeded the review limit');
    return JSON.parse(raw);
  }
  return response.json();
}
