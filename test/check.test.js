import { test } from "node:test";
import assert from "node:assert/strict";
import { keyProblems, parseConfig, priceProblems, shouldRun, verify } from "../src/check.js";

const config = parseConfig({
  mode: "live",
  publishableKeyEnv: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  plans: [
    { name: "basic", env: "STRIPE_BASIC_PRICE_ID", currency: "usd", unitAmount: 900 },
    { name: "pro", env: "STRIPE_PRO_PRICE_ID", currency: "usd", unitAmount: 1500 },
    { name: "legacy", env: "STRIPE_LEGACY_PRICE_ID", currency: "usd", unitAmount: 4900, required: false },
  ],
});

const price = (id, overrides = {}) => ({
  id,
  livemode: true,
  active: true,
  type: "recurring",
  currency: "usd",
  unit_amount: 900,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  ...overrides,
});

function fakeStripe(prices, portal = null) {
  return {
    prices: {
      retrieve: async (id) => {
        if (!prices[id]) throw Object.assign(new Error("No such price"), { code: "resource_missing" });
        return prices[id];
      },
    },
    billingPortal: { configurations: { list: async () => ({ data: portal ? [portal] : [] }) } },
  };
}

const goodEnv = {
  STRIPE_SECRET_KEY: "sk_live_x",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_x",
  STRIPE_BASIC_PRICE_ID: "price_basic",
  STRIPE_PRO_PRICE_ID: "price_pro",
};
const goodPrices = { price_basic: price("price_basic"), price_pro: price("price_pro", { unit_amount: 1500 }) };

test("a correct configuration passes", async () => {
  const { failures, lines } = await verify(config, goodEnv, fakeStripe(goodPrices));
  assert.deepEqual(failures, []);
  assert.ok(lines.some((line) => line.startsWith("✓ basic")));
  assert.ok(lines.some((line) => line.startsWith("i legacy")));
});

test("the same price under two plans is refused", async () => {
  const env = { ...goodEnv, STRIPE_PRO_PRICE_ID: "price_basic" };
  const { failures } = await verify(config, env, fakeStripe(goodPrices));
  assert.ok(failures.some((f) => f.includes("more than one plan: basic, pro")));
});

test("a wrong amount, currency, interval or an archived price is refused", () => {
  const plan = config.plans[0];
  assert.deepEqual(priceProblems(price("p"), plan, "live"), []);
  assert.match(priceProblems(price("p", { unit_amount: 1500 }), plan, "live").join(), /charges 1500, not 900/);
  assert.match(priceProblems(price("p", { currency: "eur" }), plan, "live").join(), /is EUR, not USD/);
  assert.match(priceProblems(price("p", { recurring: { interval: "year", interval_count: 1 } }), plan, "live").join(), /every month/);
  assert.match(priceProblems(price("p", { active: false }), plan, "live").join(), /archived/);
  assert.match(priceProblems(price("p", { livemode: false }), plan, "live").join(), /test-mode price/);
});

test("a missing required price fails; a missing optional one is only reported", async () => {
  const env = { ...goodEnv };
  delete env.STRIPE_PRO_PRICE_ID;
  const { failures } = await verify(config, env, fakeStripe(goodPrices));
  assert.ok(failures.includes("pro: STRIPE_PRO_PRICE_ID is not set"));
  assert.ok(!failures.some((f) => f.startsWith("legacy")));
});

test("a price Stripe cannot find fails without throwing", async () => {
  const env = { ...goodEnv, STRIPE_PRO_PRICE_ID: "price_gone" };
  const { failures } = await verify(config, env, fakeStripe(goodPrices));
  assert.ok(failures.some((f) => f.includes("price_gone could not be retrieved (resource_missing)")));
});

test("keys must match the mode, and are never printed", () => {
  assert.deepEqual(keyProblems(config, goodEnv), []);
  const testPublishable = keyProblems(config, { ...goodEnv, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_secretish" });
  assert.match(testPublishable.join(), /is a test key, but mode is "live"/);
  assert.ok(!testPublishable.join().includes("secretish"));
  assert.match(keyProblems(config, { ...goodEnv, STRIPE_SECRET_KEY: "sk_test_x" }).join(), /not a live key/);
  assert.match(keyProblems(config, { ...goodEnv, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "sk_live_oops" }).join(), /not a publishable key/);
  // A restricted live key counts as live.
  assert.deepEqual(keyProblems(config, { ...goodEnv, STRIPE_SECRET_KEY: "rk_live_x" }), []);
});

test("the Customer Portal is reported, never blocking", async () => {
  const portal = { features: { subscription_update: { enabled: true, products: [{ prices: ["price_basic"] }] } } };
  const { failures, lines } = await verify(config, goodEnv, fakeStripe(goodPrices, portal));
  assert.deepEqual(failures, []);
  assert.ok(lines.includes("i portal: plan switching offers basic"));
  assert.ok(lines.includes("! portal: plan switching does NOT offer pro"));
});

test("runs only where the config says", () => {
  const gated = parseConfig({ ...config, onlyWhen: { env: "VERCEL_ENV", equals: "production" } });
  assert.equal(shouldRun(gated, { VERCEL_ENV: "preview" }), false);
  assert.equal(shouldRun(gated, { VERCEL_ENV: "production" }), true);
  assert.equal(shouldRun(config, {}), true);
});

test("a malformed config is rejected with a clear message", () => {
  assert.throws(() => parseConfig({ plans: [] }), /non-empty array/);
  assert.throws(() => parseConfig({ plans: [{ name: "a", env: "lower", currency: "usd", unitAmount: 1 }] }), /environment variable name/);
  assert.throws(() => parseConfig({ plans: [{ name: "a", env: "A", currency: "USD", unitAmount: 1 }] }), /lowercase ISO/);
  assert.throws(() => parseConfig({ mode: "prod", plans: [{ name: "a", env: "A", currency: "usd", unitAmount: 1 }] }), /"live" or "test"/);
});
