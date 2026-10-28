export function getBearerToken(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const separator = header.indexOf(' ');
  if (separator < 1 || header.slice(0, separator).toLowerCase() !== 'bearer') return null;
  const token = header.slice(separator + 1).trim();
  if (!token || token.length > 4096 || token.includes(' ') || token.includes('\t')) return null;
  return token;
}

export async function authenticate(request) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { id: 'local-dev', email: 'local@localhost' };
  }

  const token = getBearerToken(request.headers.authorization);
  if (!token) return null;

  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? { id: user.id, email: user.email || null } : null;
}
