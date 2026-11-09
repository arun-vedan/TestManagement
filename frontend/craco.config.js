const path = require('path');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');

module.exports = {
  // Dev-only. MUI's TextareaAutosize resizes inside its own ResizeObserver
  // callback, so when a step's text wraps (e.g. the test-case Steps table)
  // the browser defers one notification to the next frame and reports
  // "ResizeObserver loop completed with undelivered notifications". That is
  // benign -- the layout settles, nothing loops -- but webpack-dev-server's
  // overlay raised it as a full-screen runtime error that blocks every click,
  // which is how parameterised-cases.spec.ts hung (2026-11-06, traced to the
  // Steps-table textareas). Production has no overlay. Every OTHER runtime
  // error still shows.
  devServer: (devServerConfig) => {
    const client = devServerConfig.client || {};
    const overlay = typeof client.overlay === 'object' ? client.overlay : { errors: true, warnings: false };
    devServerConfig.client = {
      ...client,
      overlay: {
        ...overlay,
        runtimeErrors: (error) => !/ResizeObserver loop/.test((error && error.message) || ''),
      },
    };
    return devServerConfig;
  },
  webpack: {
    plugins: [
      // Add MonacoWebpackPlugin to handle Monaco Editor setup
      new MonacoWebpackPlugin({
        languages: [] // Customize the languages if needed
      }),
    ],
    configure: (config) => {
      // Enable WebAssembly support
      config.experiments = {
        asyncWebAssembly: true,
        topLevelAwait: true,
      };

      // Add WebAssembly loader
      config.module.rules.push({
        test: /\.wasm$/,
        type: 'webassembly/async',
      });

   

      // Add TTF loader
      config.module.rules.push({
        test: /\.ttf$/,
        use: ['file-loader'],
      });

      // Add Source Map loader
      config.module.rules.push({
        test: /\.js$/,
        enforce: 'pre',
        use: ['source-map-loader'],
      });

      // Add fallbacks for Node.js core modules if needed
      config.resolve.fallback = {
        fs: false,
        path: require.resolve('path-browserify'),
        stream: require.resolve('stream-browserify'),
        constants: require.resolve('constants-browserify'),
        util: require.resolve('util/'),
        assert: require.resolve('assert/'),
      };

      // Output configuration.
      //
      // NOTE: this REPLACES CRA's own output config rather than extending it,
      // which silently dropped `publicPath`. Without it webpack defaults to a
      // relative path, so HtmlWebpackPlugin emitted `<script
      // src="main.bundle.js">` -- and a cold load of any deep URL
      // (/projects/1/workbench/testcases) resolved that against the URL's own
      // directory, got index.html back from historyApiFallback, and died with
      // "Unexpected token '<'". The app simply never booted from a pasted or
      // bookmarked link, in dev AND in the production build. That undermined
      // WP-044, which re-platformed every route onto /projects/:projectId/...
      // precisely so URLs would be shareable.
      //
      // Serving from the domain root is the assumption everywhere else in
      // this repo (Kong routes are absolute /api/v1/..., and there is no
      // frontend Dockerfile, nginx config or subpath deployment anywhere).
      // If the app is ever served from a subpath, set this and `homepage`
      // together.
      config.output = {
        globalObject: 'self',
        path: path.resolve(__dirname, 'build'),
        filename: '[name].bundle.js',
        publicPath: '/',
      };

      config.devtool = 'source-map';

      return config;
    },
  },
};