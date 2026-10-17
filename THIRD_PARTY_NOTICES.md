# Third-party notices

DevSpace Shell is an independent control interface extracted and refactored from its owner's private Dev deployment. The desktop pipe adapter and shared rate-limit admission implementation are retained from that deployment, without its data or configuration. The new portable runtime, pairing protocol, UI and installer are maintained here under the MIT license.

DevSpace itself is a separate prerequisite, not bundled, forked, or relicensed by this repository. `@waishnav/devspace` is maintained by Waishnav under its own MIT license: <https://github.com/Waishnav/devspace/blob/main/LICENSE>. Follow its installation and authentication instructions. Compatibility adapters target the codex contracts in 1.0.8 and 1.1.0-beta.4. Other releases require their actual schemas to match and a fresh pairing after a tool change. Normalized input-schema fixtures under tests/fixtures/ derive from those two published packages for compatibility tests; their fixed source URLs are recorded in each fixture. No upstream tool handlers or application binaries are bundled.

The Windows installer can download the official Node.js 24.22.0 runtime after checking the pinned SHA-256 hash. Node.js has its own MIT license and third-party notices, retained inside the downloaded runtime. Node binaries are not included in this source release. See <https://nodejs.org/en/about/previous-releases> and the runtime's LICENSE file.

ChatGPT, Codex and OpenAI are names of their respective products. This independent project is not an official OpenAI or DevSpace distribution. A compatible desktop application is needed for the optional desktop pipe adapter; its private IPC contract may change. Standard MCP task integration and manual GPT handoff remain independent of that adapter.

No third-party image, font, browser session, credential, client binary or personal memory is included. Browser assets use system fonts and local SVG/CSS only.
