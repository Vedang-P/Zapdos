function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`[env] Required env var ${name} is not set. Refusing to start.`);
  }
  return v;
}

export const env = {
  get appUrl() { return optional('APP_URL', 'http://localhost:3000'); },
  get databaseUrl() { return required('DATABASE_URL'); },
  get judge0Url() { return optional('JUDGE0_URL', 'http://localhost:2358'); },
  get judge0ApiKey() { return optional('JUDGE0_API_KEY', ''); },
  get authSecret() { return required('AUTH_SECRET'); },
  get nextauthUrl() { return optional('NEXTAUTH_URL', 'http://localhost:3000'); },
  get realtimeCorsOrigin() { return optional('REALTIME_CORS_ORIGIN', 'http://localhost:3000'); },
  get realtimeUrl() { return optional('REALTIME_URL', 'http://localhost:3002'); },
  get judgeConcurrency() {
    const v = Number(process.env.JUDGE_CONCURRENCY ?? '4');
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 4;
  },
  get googleClientId() { return optional('GOOGLE_CLIENT_ID', ''); },
  get googleClientSecret() { return optional('GOOGLE_CLIENT_SECRET', ''); },
  get githubClientId() { return optional('GITHUB_CLIENT_ID', ''); },
  get githubClientSecret() { return optional('GITHUB_CLIENT_SECRET', ''); },
};
