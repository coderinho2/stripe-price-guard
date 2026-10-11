#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseConfig, shouldRun, verify } from "./check.js";

const configPath = path.resolve(process.argv[2] ?? "price-guard.config.json");

async function main() {
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const env = process.env;

  if (!shouldRun(config, env)) {
    console.log(`stripe-price-guard: skipped (${config.onlyWhen.env} is not "${config.onlyWhen.equals}")`);
    return;
  }
  if (!env[config.secretKeyEnv]) {
    console.log(`stripe-price-guard: FAILED — ${config.secretKeyEnv} is not set`);
    process.exitCode = 1;
    return;
  }

  // Imported here so the checks themselves don't depend on the SDK.
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(env[config.secretKeyEnv], { maxNetworkRetries: 2, timeout: 20_000 });

  const { lines, failures } = await verify(config, env, stripe);
  console.log(["stripe-price-guard:", ...lines.map((line) => `  ${line}`)].join("\n"));
  if (failures.length > 0) {
    console.log(["stripe-price-guard: REFUSING TO BUILD —", ...failures.map((failure) => `  - ${failure}`)].join("\n"));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // Never print the error object itself: some SDK errors echo request details.
  console.log(`stripe-price-guard: FAILED — ${error.message}`);
  process.exitCode = 1;
});
