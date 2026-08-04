/** @type {import('next').NextConfig} */
const webpack = require('next/dist/compiled/webpack/webpack-lib');

/**
 * Next's SWC minifier discards the bodies of the IIFEs TypeScript emits for
 * decorated classes. ZenFS/memium build their structs in those IIFEs, so
 * `Attributes` collapses to `undefined`, `@field()` receives no type and the
 * filesystem never initializes ("Cannot convert undefined or null to object").
 * Next hardcodes the minifier flags and ignores `terserOptions`, so the JS
 * minimizer is replaced with one that leaves the affected chunk alone.
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
    // Server routes load these natively (ESM) — webpack's server bundle
    // breaks ZenFS class construction ("ed is not a constructor").
    experimental: {
        serverComponentsExternalPackages: ['@zenfs/core', 'just-bash', 'isomorphic-git'],
    },
    webpack: (config, { isServer }) => {
        // Client only: just-bash's gzip/gunzip/zcat use node:zlib; they are
        // documented as non-functional in the browser. Strip the scheme and
        // stub the module. The server keeps real node builtins.
        if (!isServer) {
            config.optimization.minimizer[0] = new SkipStructChunkMinifyPlugin();
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
        } else {
            // In-browser ONNX inference never runs on the server; stub it so
            // webpack doesn't chase onnxruntime-node's native binaries.
            config.resolve.alias['@huggingface/transformers'] = false;
        }
        return config;
    },
};

module.exports = nextConfig;
