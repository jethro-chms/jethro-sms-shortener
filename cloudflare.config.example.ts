import { bindings, defineConfig, triggers } from "cf/config";


export default defineConfig({
	worker: {
		name: "sms-shortener",
		compatibilityDate: "2026-05-01",
		entrypoint: "worker.js",
		triggers: [
			triggers.fetch({
				pattern: "yourdomain.com/api/sms-shorten*",
				zone: "yourdomain.com",
			}),
		],
		env: {
			AI: bindings.ai(),
			// The URL shortener's KV namespace: API keys are shared with it
			// (read-only here; keys are created and revoked by the URL shortener).
			API_KEYS: bindings.kv({
				id: "YOUR_URL_SHORTENER_KV_NAMESPACE_ID",
			}),
			// Per-key request cap, protecting the Workers AI Neuron budget.
			RATE_LIMITER: bindings.rateLimit({
				namespace: "1001",
				simple: { limit: 20, period: 60 },
			}),
			// Declare secrets here so `cf dev` loads their local values from
			// .dev.vars (see README "Tests"); production values come from
			// `cf workers secrets update`, which this does not override.
			API_KEY: bindings.secret(),
		},
	},
});
