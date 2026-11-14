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
      // AST anti-cheat: loads its own WASM runtime via __dirname, so it must not be bundled.
      'web-tree-sitter',
    ],
    // Externalized packages are not copied automatically. The judge loads the
    // pre-bundled sandbox SDK at runtime, so ship that artifact.
    outputFileTracingIncludes: {
      '/api/**/*': [
        '../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**/*',
        'sandbox/**/*',
        // AST anti-cheat reads the tree-sitter WASM runtime and the three grammars from disk (see
        // lib/anticheat/parser.ts). Only the grammars the judge supports are shipped (~5.5 MB, not the 52 MB package).
        '../../node_modules/.pnpm/web-tree-sitter@*/node_modules/web-tree-sitter/**/*',
        '../../node_modules/.pnpm/tree-sitter-wasms@*/node_modules/tree-sitter-wasms/out/tree-sitter-cpp.wasm',
        '../../node_modules/.pnpm/tree-sitter-wasms@*/node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm',
        '../../node_modules/.pnpm/tree-sitter-wasms@*/node_modules/tree-sitter-wasms/out/tree-sitter-java.wasm',
      ],
    },
  },
};

export default nextConfig;
