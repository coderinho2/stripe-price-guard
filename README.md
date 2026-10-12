# stripe-price-guard

[![test](https://github.com/coderinho2/stripe-price-guard/actions/workflows/test.yml/badge.svg)](https://github.com/coderinho2/stripe-price-guard/actions/workflows/test.yml)

Refuse a production build when your live Stripe configuration doesn't match
what your site charges.

Your pricing page shows amounts from your code. Checkout charges whatever
price ID is in your environment. The two can drift apart. A test price can
end up in production, an old price can stay in a variable, or one price ID
can be pasted into two plans. Nothing fails until a customer is charged the
wrong amount, or a webhook files their subscription under the wrong plan.
This tool turns that into a failed build.

## Why this exists

I built this for [Countorra](https://countorra.com), a personal-finance app
with Stripe subscriptions. It is in development, not launched yet. Before
launch, it refused a production build. One plan's environment variable held
another plan's price ID, so a subscriber to one plan would have been
recorded as the other. The fix took a minute. Finding it after customers had
paid would have meant wrong charges and wrong entitlements. Pricing
configuration lives in two places: your code and your Stripe account. This
tool compares them every time you build.

## What it checks

For every plan in your config, against the live Stripe API (read-only):

- the price ID is set (unless the plan is marked optional)
- the price exists, is **live** (or test, if you say so), **active**, and **recurring**
- it bills every `interval` (default: month), per seat
- currency and amount are exactly what your config says
- **no price ID is used by two plans**. Otherwise every webhook that names it is ambiguous.

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

Example output: one plan's variable held another plan's price.

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

The deploy stops and nothing reaches production.

## Tests

```bash
npm test
```

The tests use a fake Stripe client, so they need no keys and no network.

## License

MIT
