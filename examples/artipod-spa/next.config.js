/** @type {import('next').NextConfig} */
const webpack = require('next/dist/compiled/webpack/webpack-lib');

/**
 * Carried over from examples/artipod-sync (spa-ui-plan P1): Next's SWC
 * minifier discards the bodies of the IIFEs TypeScript emits for decorated
 * classes. ZenFS/memium build their structs in those IIFEs, so `Attributes`
 * collapses to `undefined` and the filesystem never initializes. The JS
 * minimizer is replaced with one that leaves the affected chunk alone;
 * scripts/export-static.mjs asserts the marker survived every build.
 */
const MEMIUM_MARKER = 'Invalid name for struct field';

class SkipStructChunkMinifyPlugin {
    apply(compiler) {
        const { Compilation, sources } = compiler.webpack;
        compiler.hooks.compilation.tap('SkipStructChunkMinify', (compilation) => {
            compilation.hooks.processAssets.tapPromise(
                { name: 'SkipStructChunkMinify', stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE },
                async (assets) => {
                    const { minify } = require('next/dist/build/swc');
                    await Promise.all(
                        Object.keys(assets)
                            .filter((name) => name.endsWith('.js'))
                            .map(async (name) => {
                                const source = assets[name].source().toString();
                                if (source.includes(MEMIUM_MARKER)) return;
                                const { code } = await minify(source, { compress: true, mangle: true });
                                compilation.updateAsset(name, new sources.RawSource(code));
                            }),
                    );
                },
            );
        });
    }
}

const nextConfig = {
    // SPA-style static export, unconditional (plan P1): there is no app/api
    // and never will be — `artipod serve` is the only backend (P2).
    output: 'export',
    // Dev loop (P2): `next dev` proxies the API to a running `artipod serve`.
    // Rewrites are unsupported under output:'export', so dev-only.
    ...(process.env.NODE_ENV === 'development'
        ? {
              async rewrites() {
                  const serve = process.env.ARTIPOD_SERVE_URL ?? 'http://127.0.0.1:2784';
                  return [
                      { source: '/api/:path*', destination: `${serve}/api/:path*` },
                      { source: '/v2/:path*', destination: `${serve}/v2/:path*` },
                  ];
              },
          }
        : {}),
    webpack: (config, { isServer }) => {
        if (!isServer) {
            config.optimization.minimizer[0] = new SkipStructChunkMinifyPlugin();
            // just-bash & friends reference node: builtins; strip the scheme
            // and stub the modules for the browser bundle.
            config.plugins.push(
                new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
                    resource.request = resource.request.replace(/^node:/, '');
                })
            );
            config.resolve.fallback = {
                fs: false,
                path: false,
                zlib: false,
            };
        }
        return config;
    },
};

module.exports = nextConfig;
