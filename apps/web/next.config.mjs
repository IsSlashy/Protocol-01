/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // get-starknet-core ships a pre-minified ESM dist; re-minifying it into the
  // scope-hoisted SSR chunk collides identifiers ("Identifier 'x' has already
  // been declared") and kills the /pay prerender. Loading it as a runtime
  // external keeps it out of the server bundle entirely.
  serverExternalPackages: ["get-starknet-core"],
  images: {
    domains: [],
  },
};

export default nextConfig;
