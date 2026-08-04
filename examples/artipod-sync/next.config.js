/** @type {import('next').NextConfig} */
const webpack = require('next/dist/compiled/webpack/webpack-lib');

const nextConfig = {
    webpack: (config) => {
        // just-bash's gzip/gunzip/zcat use node:zlib; they are documented as
        // non-functional in the browser. Strip the scheme and stub the module.
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
        return config;
    },
};

module.exports = nextConfig;
