# stripe-price-guard

[![test](https://github.com/coderinho2/stripe-price-guard/actions/workflows/test.yml/badge.svg)](https://github.com/coderinho2/stripe-price-guard/actions/workflows/test.yml)

Refuse a production build when your live Stripe configuration doesn't match
what your site charges.

Pricing pages quote amounts from your code; Checkout charges whatever price
ID is in your environment. When the two drift — a test price in production,
an old price left in a variable, one price ID pasted into two plans — nothing
fails until a customer is charged the wrong amount or a webhook files their
subscription under the wrong plan. This tool makes that a failed build
instead.

## Why this exists

I built this for [Countorra](https://countorra.com), a personal-finance product
with Stripe subscriptions. On launch day it refused the production build: one
plan's environment variable held another plan's price ID, so a subscriber to
one plan would have been recorded as the other. The fix took a minute; finding
it after customers had paid would have meant wrong charges and wrong
entitlements. Pricing configuration lives in two places — your code and your
Stripe account — and this makes the build the moment they're compared.

## What it checks

For every plan in your config, against the live Stripe API (read-only):

- the price ID is set (unless the plan is marked optional)
- the price exists, is **live** (or test, if you say so), **active**, and **recurring**
- it bills every `interval` (default: month), per seat
- currency and amount are exactly what your config says
- **no price ID is used by two plans** — otherwise every webhook that names it is ambiguous

And for your keys:

- the secret key's mode matches `mode`
- if `publishableKeyEnv` is set: the publishable key exists and is the same mode
  (a mismatch means embedded Checkout can't load sessions your server creates)

It also *reports*, without failing, whether the Customer Portal's plan
switching offers each current price.

It never prints a key.

## Usage

```bash
npm install --save-dev stripe-price-guard stripe
```

Create `price-guard.config.json` (see `price-guard.config.example.json`):

```json
{
  "mode": "live",
  "onlyWhen": { "env": "VERCEL_ENV", "equals": "production" },
  "publishableKeyEnv": "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "plans": [
    { "name": "basic", "env": "STRIPE_BASIC_PRICE_ID", "currency": "usd", "unitAmount": 900 },
    { "name": "pro", "env": "STRIPE_PRO_PRICE_ID", "currency": "usd", "unitAmount": 1500 }
  ]
}
```

Run it before your build:

```json
{ "scripts": { "build": "stripe-price-guard && next build" } }
```

`onlyWhen` keeps it out of local and preview builds, which usually don't
have live keys.

## Example

A real catch: one plan's variable held another plan's price.

```
stripe-price-guard:
  ✓ basic price_1Abc…: USD 9.00 / month
  ✓ pro price_1Def…: USD 15.00 / month
  ✗ legacy price_1Def…: USD 15.00 / month
  i portal: plan switching is off
stripe-price-guard: REFUSING TO BUILD —
  - price_1Def… is configured for more than one plan: pro, legacy
  - legacy price_1Def… charges 1500, not 4900
```

The deploy stops; the site that's already live keeps running.

## Tests

```bash
npm test
```

The tests use a fake Stripe client — no keys, no network.

## License

MIT
