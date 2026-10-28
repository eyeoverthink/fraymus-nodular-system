function secureOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}

export function configuredOrigins(value = '') {
  return new Set(String(value).split(',').map((entry) => secureOrigin(entry.trim())).filter(Boolean));
}

export function contentSecurityPolicy(supabaseUrl = '', apiUrl = '') {
  const connectSources = new Set(["'self'"]);
  const authOrigin = secureOrigin(supabaseUrl);
  const backendOrigin = secureOrigin(apiUrl);
  if (authOrigin) connectSources.add(authOrigin);
  if (backendOrigin) connectSources.add(backendOrigin);
  return `default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ${[...connectSources].join(' ')}`;
}

export function isSameOriginRequest(origin, host) {
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
