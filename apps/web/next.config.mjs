const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Transpile workspace packages so Next handles their TS source directly.
  transpilePackages: [
    '@zapdos/db',
    '@zapdos/elo',
    '@zapdos/judge',
    '@zapdos/match',
    '@zapdos/realtime',
  ],
  experimental: {
    // Trace dependencies from the pnpm workspace root so serverless bundles
    // include hoisted packages and Prisma's native query engine.
    outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
    // Monorepo-friendly: include workspace packages in server/native builds.
    serverComponentsExternalPackages: [
      '@prisma/client',
      'bcryptjs',
      'bullmq',
      'ioredis',
    ],
    // Externalized packages are not copied automatically. The judge loads the
    // pre-bundled sandbox SDK at runtime, so ship that artifact.
    outputFileTracingIncludes: {
      '/api/**/*': [
        '../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**/*',
        'sandbox/**/*',
      ],
    },
  },
};

export default nextConfig;
