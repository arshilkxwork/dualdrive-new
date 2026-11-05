// One-time registration of @keyholder with Switch. Prints the agent id and the
// API key (Switch shows the key once) for .env.
//
// Registers through POST /agents with its own integration profile rather than
// as an "other" agent from the Gateway: those get the session_passive model,
// which Switch reports as never live and answers for with an
// "awaiting a manual poll" notice every time a reviewer approves.

import { loadEnv } from './config.ts';

loadEnv();
const bridgeUrl = process.env.SWITCH_BRIDGE_URL?.trim().replace(/\/+$/, '');
const token = process.env.SWITCH_REGISTRATION_TOKEN?.trim();
const handle = process.env.KEYHOLDER_HANDLE?.trim() || 'keyholder';
if (!bridgeUrl || !token) {
  console.error('Set SWITCH_BRIDGE_URL and SWITCH_REGISTRATION_TOKEN in .env first.');
  process.exit(1);
}

const response = await fetch(`${bridgeUrl}/agents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: handle,
    display_name: 'Keyholder',
    description: 'Merges a pull request only after the named reviewers approve the audited commit. It runs no model.',
    connector_type: 'external',
    integration_profile: {
      connection_model: 'always_on',
      message_exchange: true,
      pre_invocation_mediation: [],
      post_invocation_mediation: [],
      event_reporting: [],
    },
  }),
});

if (!response.ok) {
  console.error(`Registration failed with ${response.status}: ${await response.text()}`);
  process.exit(1);
}
const { id, api_key: apiKey } = (await response.json()) as { id: string; api_key: string };
console.log('Registered. Add these to .env (the key is not shown again):\n');
console.log(`KEYHOLDER_AGENT_ID=${id}`);
console.log(`KEYHOLDER_API_KEY=${apiKey}`);
