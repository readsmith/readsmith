/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship ESM dist; transpiling them keeps Next's bundler
  // happy across the ESM-only dependency graph (unified, shiki, etc.).
  transpilePackages: [
    "@readsmith/components",
    "@readsmith/mdx",
    "@readsmith/config",
    "@readsmith/model",
  ],
};

export default nextConfig;
