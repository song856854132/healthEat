import type { NextConfig } from "next";

// Architecture C (design doc): the browser only ever talks to this origin. Every /api/*
// request is proxied to the Express service, so session cookies stay same-origin and no
// CORS is needed. API_ORIGIN is read at build time; CI sets it per environment.
// `||`, not `??`: an empty API_ORIGIN (CI can export it blank) must fall back too, or the
// rewrite becomes "/api/:path*" -> "/api/:path*" and `next build` fails with "Invalid rewrite".
const apiOrigin = (process.env.API_ORIGIN || "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next.js aborts proxied (external) rewrites after 30 s by default, which returned 500 on the
  // 65 s spike request. The API function window on Vercel Hobby is 300 s; stay just under it.
  experimental: { proxyTimeout: 290_000 },
  transpilePackages: ["@healtheat/shared"],
  env: { NEXT_PUBLIC_API_ORIGIN_LABEL: apiOrigin },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
