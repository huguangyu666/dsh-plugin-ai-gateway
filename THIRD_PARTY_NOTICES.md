# Third-party notices

## Magpie community WorkBuddy adapter

- Package: `@magpie-community/opencode-workbuddy-auth` 0.1.24
- Source: https://github.com/magpie-community/plugins/tree/main/packages/workbuddy
- npm tarball integrity: `sha512-2X5rjDHdxOBp6q329N2593qZ+2XVysAeS9LTzXAdKggFMyzlmXeOq+e2K1Z3IJ1PN1kiZo8iUVogA0mU3plJTg==`
- Local changes: per-instance transport and cancellation signals, cancellable login polling.

MIT License

Copyright (c) 2026 magpie-community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Magpie community Qoder adapter

- Package: `@magpie-community/opencode-qoder-auth` 0.2.33 (MIT)
- Author: yetone / magpie-community contributors
- Source: https://github.com/magpie-community/plugins/tree/main/packages/qoder
- Source commit recorded by npm: `da079585d9cdd1fcbedfcfc60bbff316efe5e76a`
- npm tarball integrity: `sha512-eklfBB9snhXl4UzgSWUy7gAdbRKyQFzlCtgq1n7aO4qrAz7ZjbIZJgoDDAGbOuQ3RW8Kt23pk6Xg3wQk3qKaYA==`
- Local changes: per-instance fetch and AbortSignal injection for account, model, chat, queue and campaign requests; cancellable device-login polling. No authentication or model-protocol changes.
- DSH wiring: shared subscription lifecycle, an authenticated loopback endpoint, and the existing settings panel. The upstream check-in, PAT and VPC methods are not exposed by the panel.
- The protocol originates in https://github.com/ufec/CLIProxyAPI (MIT). The package ships the following original notice verbatim:

MIT License

Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
