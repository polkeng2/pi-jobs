// Secrets (.dev.vars / wrangler secret) are not in the types `wrangler types` generates. ACCESS_AUD is a plain var.
interface Env {
  FINNHUB_API_KEY?: string;
  EDGAR_CONTACT?: string;
  ACCESS_AUD?: string;
}
