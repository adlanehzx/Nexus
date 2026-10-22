/**
 * Babel configuration for React Native.
 *
 * Use the official preset. This package has no decorators or custom transforms.
 */
module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    // React Native's preset does not transform Zod's namespace export syntax,
    // so handle it explicitly before Metro consumes the bundle.
    "@babel/plugin-transform-export-namespace-from",
  ],
};
