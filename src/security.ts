export async function verifySlackRequest(
  rawBody: string, headers: Headers, secret: string, nowMs = Date.now(),
): Promise<boolean> {
  const timestamp = headers.get('x-slack-request-timestamp') ?? '';
  const signature = headers.get('x-slack-signature') ?? '';
  if (!secret || !/^\d+$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const bytes = Uint8Array.from(signature.slice(3).match(/.{2}/g)!, (hex) => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`v0:${timestamp}:${rawBody}`));
}
