# Third-party notices

## Project licence — NOT YET CHOSEN

The owner of this repository has **not chosen a licence yet**. Until a `LICENSE` file is added, default
copyright applies: the code is publicly visible but no permission to reuse, modify or redistribute it is
granted. This is flagged deliberately; pick a licence (for example MIT or Apache-2.0) before accepting
outside contributions.

## Design references

`design-references/stitch_ai_roulette_lab/` contains the original Google Stitch export (HTML, `DESIGN.md`,
screenshot) supplied by the repository owner. It is kept byte-for-byte unchanged as a visual reference and
is not executed by the application. Its HTML loads fonts and Tailwind from public CDNs; the application
itself does not — styling is compiled locally.

## Patterns adapted (no code copied)

### MoneyPrinterTurbo
- Source: https://github.com/harry0703/MoneyPrinterTurbo (reviewed at commit `3d5f4e4`)
- Licence: MIT — Copyright (c) 2024 Harry
- What we took: *ideas only*, re-implemented in TypeScript — a provider registry with required-field
  checks, normalising model output (stripping `<think>` blocks and code fences), masking credentials in
  error messages, isolating the Claude Code CLI in an empty working directory with a reduced environment,
  pre-flight checks before paid calls, and launcher scripts that resolve paths from the script location.
- What we deliberately did differently: typed errors instead of error strings, bounded retries with
  back-off, timeouts on every provider call, cancellation, loopback-only binding.
- No MoneyPrinterTurbo source code, fonts, audio or video dependencies are included.

### Stitch "react-components" skill validator
- Source: Google Labs Stitch skills (`stitch-build/react-components/scripts/validate.js`)
- Licence: Apache License 2.0 — Copyright 2026 Google LLC
- `scripts/validate-components.mjs` re-implements the same two checks (every component declares a
  `…Props` interface; no hard-coded hex colours in `className`) using the TypeScript compiler API.

## Runtime and build dependencies

Installed from npm and listed in `package.json` / `package-lock.json`; their licences travel with the
packages in `node_modules/`.

| Package | Licence |
|---|---|
| react, react-dom | MIT |
| fastify, @fastify/static | MIT |
| zod | MIT |
| @anthropic-ai/sdk | MIT |
| lucide-react | ISC |
| @fontsource-variable/inter (Inter typeface) | OFL-1.1 (SIL Open Font License 1.1 — the licence the package declares; Copyright 2016 The Inter Project Authors) |
| @fontsource-variable/jetbrains-mono (JetBrains Mono typeface) | OFL-1.1 (SIL Open Font License 1.1 — the licence the package declares; Copyright 2020 The JetBrains Mono Project Authors) |
| tailwindcss, @tailwindcss/vite | MIT |
| vite, @vitejs/plugin-react, vitest | MIT |
| typescript | Apache-2.0 |
| tsx, concurrently, jsdom, @testing-library/* | MIT |

The two typefaces are bundled into the production build (`dist/web/assets/*.woff2`, not committed). Their full
OFL-1.1 text ships with the packages: `node_modules/@fontsource-variable/inter/LICENSE` and
`node_modules/@fontsource-variable/jetbrains-mono/LICENSE`.

## Optional components (not installed by default)

### Laya (Convai Innovations)
- Model card: https://huggingface.co/convaiinnovations/laya · SDK: https://pypi.org/project/laya/ ·
  Source: https://github.com/NandhaKishorM/laya
- Licence: Apache-2.0 (code and weights)
- Used only if you install it yourself (see `optional/laya/`). Weights are downloaded by the Laya SDK
  from Hugging Face on first use; none are stored in this repository.

### Claude Code CLI (Anthropic)
- Not distributed with this project. The optional adapter runs *your own* installed, unmodified
  `claude` binary under your own login and Anthropic's terms.
