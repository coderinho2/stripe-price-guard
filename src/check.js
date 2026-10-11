/**
 * The checks behind stripe-price-guard. Pure functions plus one async
 * `verify` that talks to Stripe through whatever client it is given, so the
 * whole thing can be tested with a fake.
 */

const MODES = new Set(["live", "test"]);

/** Throws on a malformed config; returns it normalised. */
export function parseConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  const mode = raw.mode ?? "live";
  if (!MODES.has(mode)) throw new Error(`config.mode must be "live" or "test", not "${mode}"`);
  if (!Array.isArray(raw.plans) || raw.plans.length === 0) throw new Error("config.plans must be a non-empty array");

  const names = new Set();
  const plans = raw.plans.map((plan, index) => {
    const where = `plans[${index}]`;
    if (typeof plan.name !== "string" || !plan.name) throw new Error(`${where}.name is required`);
    if (names.has(plan.name)) throw new Error(`plan "${plan.name}" is listed twice`);
    names.add(plan.name);
    if (typeof plan.env !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(plan.env)) throw new Error(`${where}.env must be an environment variable name`);
    if (typeof plan.currency !== "string" || !/^[a-z]{3}$/.test(plan.currency)) throw new Error(`${where}.currency must be a lowercase ISO code, e.g. "usd"`);
    if (!Number.isInteger(plan.unitAmount) || plan.unitAmount < 0) throw new Error(`${where}.unitAmount must be a whole number of minor units`);
    const interval = plan.interval ?? "month";
    if (!["day", "week", "month", "year"].includes(interval)) throw new Error(`${where}.interval must be day, week, month or year`);
    return { name: plan.name, env: plan.env, currency: plan.currency, unitAmount: plan.unitAmount, interval, required: plan.required !== false };
  });

  return {
    mode,
    plans,
    secretKeyEnv: raw.secretKeyEnv ?? "STRIPE_SECRET_KEY",
    publishableKeyEnv: raw.publishableKeyEnv ?? null,
    onlyWhen: raw.onlyWhen ?? null,
  };
}

/** Whether the guard should run in this environment at all. */
export function shouldRun(config, env) {
  if (!config.onlyWhen) return true;
  return env[config.onlyWhen.env] === config.onlyWhen.equals;
}

const isLiveSecret = (key) => /^(sk|rk)_live_/.test(key);
const isTestSecret = (key) => /^(sk|rk)_test_/.test(key);

/** Problems with the API keys, as sentences. Never includes a key. */
export function keyProblems(config, env) {
  const problems = [];
  const secret = env[config.secretKeyEnv] ?? "";
  if (!secret) problems.push(`${config.secretKeyEnv} is not set`);
  else if (config.mode === "live" && !isLiveSecret(secret)) problems.push(`${config.secretKeyEnv} is not a live key, but mode is "live"`);
  else if (config.mode === "test" && !isTestSecret(secret)) problems.push(`${config.secretKeyEnv} is not a test key, but mode is "test"`);

  if (config.publishableKeyEnv) {
    const publishable = env[config.publishableKeyEnv] ?? "";
    if (!publishable) problems.push(`${config.publishableKeyEnv} is not set`);
    else if (!/^pk_(live|test)_/.test(publishable)) problems.push(`${config.publishableKeyEnv} is not a publishable key (pk_live_… or pk_test_…)`);
    else if (publishable.startsWith("pk_live_") !== (config.mode === "live")) {
      problems.push(`${config.publishableKeyEnv} is a ${publishable.startsWith("pk_live_") ? "live" : "test"} key, but mode is "${config.mode}"`);
    }
  }
  return problems;
}

/** What is wrong with one Stripe price for one plan. Empty means correct. */
export function priceProblems(price, plan, mode) {
  const problems = [];
  if (price.livemode !== (mode === "live")) problems.push(`is a ${price.livemode ? "live" : "test"}-mode price`);
  if (!price.active) problems.push("is archived");
  if (price.type !== "recurring") problems.push("is not recurring");
  if (price.recurring?.interval !== plan.interval || price.recurring?.interval_count !== 1) {
    problems.push(`is not billed every ${plan.interval}`);
  }
  if (price.recurring?.usage_type && price.recurring.usage_type !== "licensed") problems.push("is not a licensed (per-seat) price");
  if (price.currency !== plan.currency) problems.push(`is ${String(price.currency).toUpperCase()}, not ${plan.currency.toUpperCase()}`);
  if (price.unit_amount !== plan.unitAmount) problems.push(`charges ${price.unit_amount}, not ${plan.unitAmount}`);
  return problems;
}

function describe(price) {
  const amount = typeof price.unit_amount === "number" ? (price.unit_amount / 100).toFixed(2) : "?";
  return `${String(price.currency).toUpperCase()} ${amount} / ${price.recurring?.interval ?? "one-off"}${price.active ? "" : " (archived)"}`;
}

/**
 * Runs every check. `stripe` needs `prices.retrieve(id)` and, optionally,
 * `billingPortal.configurations.list(params)`.
 * Returns report lines and blocking failures; never throws for a bad price.
 */
export async function verify(config, env, stripe) {
  const lines = [];
  const failures = [...keyProblems(config, env)];

  // The same price under two plans makes "which plan did they buy?"
  // ambiguous for every webhook that names it.
  const byId = new Map();
  for (const plan of config.plans) {
    const id = env[plan.env];
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), plan.name]);
  }
  for (const [id, plans] of byId) {
    if (plans.length > 1) failures.push(`${id} is configured for more than one plan: ${plans.join(", ")}`);
  }

  const prices = new Map();
  for (const plan of config.plans) {
    const id = env[plan.env];
    if (!id) {
      if (plan.required) failures.push(`${plan.name}: ${plan.env} is not set`);
      else lines.push(`i ${plan.name}: no price configured (optional)`);
      continue;
    }
    let price;
    try {
      price = await stripe.prices.retrieve(id);
    } catch (error) {
      failures.push(`${plan.name} ${id} could not be retrieved (${error?.code ?? error?.type ?? "error"})`);
      continue;
    }
    prices.set(plan.name, price);
    const problems = priceProblems(price, plan, config.mode);
    lines.push(`${problems.length ? "✗" : "✓"} ${plan.name} ${id}: ${describe(price)}`);
    for (const problem of problems) failures.push(`${plan.name} ${id} ${problem}`);
  }

  // Reported, never blocking: the portal is configured in the Dashboard.
  if (stripe.billingPortal?.configurations?.list) {
    try {
      const { data } = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
      const update = data[0]?.features?.subscription_update;
      if (!data[0]) lines.push("i portal: no default configuration");
      else if (!update?.enabled) lines.push("i portal: plan switching is off");
      else {
        const offered = new Set((update.products ?? []).flatMap((product) => product.prices ?? []));
        for (const [name, price] of prices) {
          lines.push(`${offered.has(price.id) ? "i" : "!"} portal: plan switching ${offered.has(price.id) ? "offers" : "does NOT offer"} ${name}`);
        }
      }
    } catch (error) {
      lines.push(`i portal: not readable (${error?.type ?? "error"})`);
    }
  }

  return { lines, failures };
}
