/* eslint-disable @typescript-eslint/no-var-requires */
import path from 'path';

// Wave A-2 regression guard.
//
// craco.config.js REPLACES webpack's `config.output` wholesale rather than
// extending it, which silently dropped `publicPath`. Webpack then defaults to
// a relative path, so HtmlWebpackPlugin emitted `<script src="main.bundle.js">`
// -- and a cold load of any deep URL (/projects/1/workbench/testcases)
// resolved that against the URL's own directory, got index.html back from the
// history fallback, and died with "Unexpected token '<'". The app never booted
// from a pasted or bookmarked link, in dev OR in the production build.
//
// That is not something the E2E suite can guard: every existing spec works
// around it by navigating to '/' first, and a dev server only re-reads this
// config at startup. So the guard lives here, on the config itself.
describe('webpack output config', () => {
  it('sets an absolute publicPath, so deep links resolve their bundle', () => {
    const craco = require(path.resolve(__dirname, '../../craco.config.js'));
    const webpackConfigure = craco.webpack.configure;

    // Minimal shape the configure() function touches: it pushes a wasm rule,
    // sets experiments/resolve fallbacks, then replaces output.
    const fakeConfig = {
      module: { rules: [] as unknown[] },
      resolve: { fallback: {} as Record<string, unknown> },
      experiments: {},
      plugins: [] as unknown[],
    };
    const produced = webpackConfigure(fakeConfig as never, { env: 'production' } as never);

    expect(produced.output).toBeDefined();
    expect(produced.output.publicPath).toBe('/');
  });
});
