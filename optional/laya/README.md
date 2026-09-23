# Optional: Laya local classifier player

**Laya is optional.** Nothing in this folder is part of `npm install`; the app works without it and
shows the Laya player as "not reachable" until you start the server below.

## What Laya is — and is not

[Laya](https://pypi.org/project/laya/) (Convai Innovations, Apache-2.0) is a small local
**classifier**. Given a short text description of the game state and a fixed list of labels, it returns
a probability for each label and the top label. It:

- **does not generate text** and produces **no output tokens** (the app shows output tokens as
  "not applicable", never as 0 generated tokens);
- is **not a roulette model** and **cannot predict outcomes** — spins are independent and random;
- runs **locally** (CPU or CUDA), so there is **no cloud inference charge**.

How the app uses it: Laya chooses exactly one of these **13 labels**
`skip, red, black, odd, even, low, high, dozen_1, dozen_2, dozen_3, column_1, column_2, column_3`.
There is no `stop` label — a classifier cannot end the session; you and the session limits do.
The **app's adapter** turns a bet label into a single bet whose **stake is fixed at the session minimum**
— Laya only picks the category. Every decision's explanation says so, e.g.
`Laya classifier chose 'red' (label probability 0.93, Laya confidence 0.85; raw, uncalibrated). Stake fixed at the session minimum by the adapter.`
Both numbers are Laya's raw, uncalibrated scores (the label's probability and Laya's own confidence, which are
different quantities); they describe how well the label fits the text, not a chance of winning.
A label outside that list (including a returned `stop`) is rejected as invalid output; it is never turned into a
stop or into some other bet.

## Install (separate Python environment)

Requires Python 3 (a version supported by `laya` and PyTorch; check the PyPI page). From the repository root:

```powershell
# Windows (PowerShell)
python -m venv .venv-laya
.\.venv-laya\Scripts\python -m pip install -r optional\laya\requirements.txt
```

```bash
# macOS / Linux
python3 -m venv .venv-laya
.venv-laya/bin/python -m pip install -r optional/laya/requirements.txt
```

`requirements.txt` pins `laya[serve]==0.3.7` (the `serve` extra provides the `laya-serve` HTTP server).
`.venv-laya/` and model weight files are git-ignored.

The start scripts can do these two steps for you: `start-laya.ps1 -Install` / `start-laya.sh --install`.

**Download size:** the model weights are fetched from Hugging Face the first time a checkpoint is used —
roughly **0.6–2.3 GB** depending on which checkpoints load (`english`, `multilingual`, `typed-decisions`).
The first classification can therefore take minutes; run *Test connection* and one manual step before
starting an autonomous session, or raise the decision timeout.

## Start

Always bind to loopback. `laya-serve` itself defaults to `0.0.0.0` (all interfaces), so the scripts set
`LAYA_HOST=127.0.0.1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\optional\laya\start-laya.ps1            # port 8000
powershell -ExecutionPolicy Bypass -File .\optional\laya\start-laya.ps1 -Port 8010
```

```bash
optional/laya/start-laya.sh              # port 8000
optional/laya/start-laya.sh --port 8010
```

Manual equivalent: set `LAYA_HOST=127.0.0.1` (and optionally `LAYA_PORT`) in the environment, then run
`laya-serve` from the virtual environment.

## Connect the app

In the app's `.env` (see `docs/configuration.md`):

| Variable | Default | Meaning |
|---|---|---|
| `LAYA_BASE_URL` | `http://127.0.0.1:8000` | Where `laya-serve` listens. |
| `LAYA_CHECKPOINT` | `english` | Sent as `model`; Laya's router picks one if it does not recognise it. |
| `LAYA_API_KEY` | *(empty)* | Only if you started `laya-serve` with `LAYA_API_KEY`; the app then sends `Authorization: Bearer …`. |

*Test connection* calls `GET /health` only (no classification is run). A decision calls
`POST /v1/systemone` with the text state and one `choice` question.

## Honesty notes

- Usage shows **input tokens only** (as reported by `laya-serve`); output tokens are not applicable.
- Cost shows **"local — no cloud charge"**. Your own electricity/hardware cost is not measured.
- Probabilities are Laya's confidence in a *label given the text*, not a probability of winning.
- **Tested live** on 2026-09-23 (Windows 11, CPU, `laya[serve]==0.3.7`, checkpoint `english`, `laya-serve` on
  127.0.0.1:8000): *Test connection* and a 3-round session through the app (skip, red, red), decisions validated
  and settled, about 1.9 s per decision. The automated tests use a **mock** `laya-serve` (fixture). Details:
  `docs/providers-cli-laya.md` and `docs/verification.md`.
