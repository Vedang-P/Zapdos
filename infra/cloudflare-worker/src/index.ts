/**
 * Cloudflare Worker: public entrypoint for Zapdos.
 *
 *   /socket.io/*  -> Render realtime service (WebSocket + polling)
 *   everything else -> Vercel Next.js app
 *
 * The Worker also runs a 5-minute cron that pings Render's /health endpoint.
 * Render's free web services spin down after 15 minutes without traffic, so
 * without this the first player to queue would wait ~30-60s for a cold start.
 */

interface Env {
  VERCEL_ORIGIN: string;
  REALTIME_ORIGIN: string;
}

function origin(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRealtimePath(pathname: string): boolean {
  return pathname === '/socket.io' || pathname.startsWith('/socket.io/');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    const base = isRealtimePath(url.pathname)
      ? origin(env.REALTIME_ORIGIN)
      : origin(env.VERCEL_ORIGIN);
    const target = new URL(`${url.pathname}${url.search}`, base);

    const headers = new Headers(request.headers);
    // Let the upstream set its own Host; the URL already determines it.
    headers.delete('host');

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    try {
      return await fetch(new Request(target, init));
    } catch (error) {
      console.error('[worker] proxy failed', target.toString(), error);
      return new Response('Bad gateway', { status: 502 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const targets = [
      `${origin(env.REALTIME_ORIGIN)}/health`,
      `${origin(env.VERCEL_ORIGIN)}/api/health`,
    ];

    ctx.waitUntil(
      Promise.allSettled(
        targets.map(async (target) => {
          const res = await fetch(target, {
            headers: { 'User-Agent': 'zapdos-keepalive/1.0' },
          });
          if (!res.ok) {
            console.error(`[worker] keepalive ${target} -> HTTP ${res.status}`);
          }
        }),
      ),
    );
  },
};
