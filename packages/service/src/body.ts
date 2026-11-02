/**
 * Reads a request body as text, up to `maxBytes` of its UTF-8 bytes. Returns
 * `null` as soon as the body is over the cap, from the declared
 * `content-length` or from the bytes actually read, so a client that sends no
 * length cannot make the service buffer more than the cap. Counting bytes and
 * not `string.length` matters: a UTF-16 length undercounts non-ASCII text up
 * to three times.
 */
export async function readTextCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
