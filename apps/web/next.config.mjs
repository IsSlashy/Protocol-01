/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // get-starknet-core ships a pre-minified ESM dist; re-minifying it into the
  // scope-hoisted SSR chunk collides identifiers ("Identifier 'x' has already
  // been declared") and kills the app prerender. Loading it as a runtime
  // external keeps it out of the server bundle entirely.
  serverExternalPackages: ["get-starknet-core"],
  images: {
    domains: [],
  },
  // The app moved from /pay to /app. The old path has been the live demo link
  // since launch — it is in the handoff docs, in chat history, and in whatever
  // bookmarks visitors kept — so it redirects permanently instead of 404ing.
  async redirects() {
    return [{ source: "/pay", destination: "/app", permanent: true }];
  },
};

export default nextConfig;
