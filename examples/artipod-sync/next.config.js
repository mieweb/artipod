/** @type {import('next').NextConfig} */
const webpack = require('next/dist/compiled/webpack/webpack-lib');

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
