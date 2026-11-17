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
			triggers.fetch({
				pattern: "yourdomain.com/sms-shortener/*",
				zone: "yourdomain.com",
			}),
		],
		env: {
			AI: bindings.ai(),
			// The jethro.au account Worker (the URL shortener), which issues API
			// keys and records each organisation's consent to this service; asked
			// GET /api/authorize?service=sms-shortener for every request.
			ACCOUNT: bindings.worker({ worker: "url-shortener" }),
			// Per-key request cap, protecting the Workers AI Neuron budget.
			RATE_LIMITER: bindings.rateLimit({
				namespace: "1001",
				simple: { limit: 20, period: 60 },
			}),
			// Named on the privacy page (/sms-shortener/privacy).
			PRIVACY_OPERATOR: bindings.text("Your organisation name"),
			PRIVACY_CONTACT: bindings.text("privacy@yourdomain.com"),
			// Declare secrets here so `cf dev` loads their local values from
			// .dev.vars (see README "Tests"); production values come from
			// `cf workers secrets update`, which this does not override.
			API_KEY: bindings.secret(),
		},
	},
});
