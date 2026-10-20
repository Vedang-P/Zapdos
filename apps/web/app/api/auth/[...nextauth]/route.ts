import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkLoginRateLimit } from '@/lib/rate-limit';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function getClientIp(req: NextRequest): string {
  // Cloudflare sets CF-Connecting-IP and overwrites any client-supplied value.
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  // Vercel/Cloudflare prepend the client address; the first entry is the
  // closest thing to the real client.
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }

  return 'unknown';
}

const handler = NextAuth(authOptions);

async function rateLimitedHandler(req: NextRequest, context: { params: { nextauth: string[] } }) {
  // Only rate-limit POST (login attempts), not GET (session checks)
  if (req.method === 'POST') {
    const ip = getClientIp(req);
    try {
      const { allowed, retryAfterMs } = await checkLoginRateLimit(ip);
      if (!allowed) {
        return NextResponse.json(
          { error: 'Too many login attempts. Please try again later.' },
          {
            status: 429,
            headers: {
              'Retry-After': String(Math.ceil((retryAfterMs ?? 60_000) / 1000)),
            },
          },
        );
      }
    } catch (err) {
      // Fail open: a database hiccup must not lock users out of sign-in.
      console.error('[auth] login rate limit failed:', err);
    }
  }
  return handler(req, context);
}

export { rateLimitedHandler as GET, rateLimitedHandler as POST };
