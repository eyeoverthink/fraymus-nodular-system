export function contentSecurityPolicy(supabaseUrl = '') {
  const connectSources = new Set(["'self'"]);
  if (typeof supabaseUrl === 'string' && supabaseUrl.length <= 2048) {
    try {
      const url = new URL(supabaseUrl);
      if (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      ) {
        connectSources.add(url.origin);
      }
    } catch {
      // An invalid auth URL must not weaken the page policy.
    }
  }
  return `default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ${[...connectSources].join(' ')}`;
}
