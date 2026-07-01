# gifski WebAssembly

This app uses `gifski-wasm`, a browser wrapper around ImageOptim/gifski.

- Upstream encoder: https://github.com/ImageOptim/gifski/
- Browser package: https://www.npmjs.com/package/gifski-wasm
- License: AGPL-3.0-or-later

The worker imports the single-threaded browser module from `gifski-wasm`. The multi-threaded module can be added later, but it requires cross-origin isolation headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`) wherever the PWA is hosted.
