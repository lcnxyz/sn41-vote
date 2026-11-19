/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    '@polkadot/api',
    '@polkadot/util-crypto',
    '@polkadot/wasm-crypto',
    'better-sqlite3',
  ],
};

export default nextConfig;
