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
    // Monorepo-friendly: include workspace packages in server/native builds.
    serverComponentsExternalPackages: [
      '@prisma/client',
      'bcryptjs',
      'bullmq',
      'ioredis',
      '@vercel/sandbox',
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer && Array.isArray(config.externals)) {
      // `@vercel/sandbox` pulls in undici 7, whose private-class-field syntax
      // webpack 5 (Next 14) can't parse. Keep it as a runtime require.
      config.externals.push('@vercel/sandbox');
    }
    return config;
  },
};

export default nextConfig;
