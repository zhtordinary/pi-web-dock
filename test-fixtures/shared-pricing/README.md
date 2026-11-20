# Shared pricing test inputs (TEST-ONLY)

These four files are an immutable input snapshot used only by the sealed
private-`HOME` tests. They are **not** production pricing truth, a runtime data
source, or a replacement for the optional external pricing script that a
deployment points `PI_CONVERSATION_COST_SCRIPT` at. The tests copy the data file
to a private cache with fresh metadata and point the frozen Python/Node adapter
at this selected-tree fixture; they do not refresh from the network or write a
shared cache.

The adapter bytes are imported unchanged from the maintainer's pricing-skill
snapshot recorded by `manifest.json`. Each file records its source label, byte
count and SHA-256; the manifest also records locked test package versions and
the test-only boundary. The frozen dataset retains its own snapshot identity when
adapters are updated. Keep those identities in sync with the imported bytes; do
not hand-edit rates, engine logic, or the Python adapter.

Attribution and license boundary:

- `scripts/session_cost.py`, `genai-prices/cli.cjs`, and the integration
  plumbing in `genai-prices/engine.cjs` are maintainer-written adapters and are
  distributed under this repository's MIT license.
- `genai-prices/engine.cjs` delegates lookup and arithmetic to the declared
  dev-only `@pydantic/genai-prices@0.1.9` package. The package's MIT license
  and npm integrity are recorded by `package-lock.json`.
- `data/genai-prices-v2.json` is a frozen copy of the MIT-licensed
  `genai-prices` price data, retained as a test input only. Changes to the
  upstream dataset require a new explicit fixture identity and focused test
  review; do not silently refresh it.

### Pydantic license for the frozen price data

The following notice is reproduced from the
[upstream license](https://github.com/pydantic/genai-prices/blob/main/LICENSE):

```text
The MIT License (MIT)

Copyright (c) Pydantic Services Inc. 2025 to present

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
```
