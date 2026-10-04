module.exports = {
  plugins: {
    // Tailwind v4 — matches the generation @mieweb/ui's compiled CSS was
    // built with (v3's plugin chokes on its @layer rules).
    '@tailwindcss/postcss': {},
  },
};
