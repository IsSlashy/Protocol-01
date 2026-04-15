/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@protocol-01/arcium-sdk',
    '@protocol-01/privacy-sdk',
    '@protocol-01/privacy-toolkit',
  ],
};

export default nextConfig;
