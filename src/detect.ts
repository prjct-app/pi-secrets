/**
 * Credentials with a recognizable shape, for catching one pasted into the
 * chat before it is sent. Generic high-entropy strings are left alone: they
 * are too often hashes, IDs and commit SHAs.
 */
const SHAPES: readonly { readonly label: string; readonly name: string; readonly pattern: RegExp }[] = [
  { label: 'Anthropic key', name: 'ANTHROPIC_API_KEY', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'OpenRouter key', name: 'OPENROUTER_API_KEY', pattern: /sk-or-v1-[A-Za-z0-9]{32,}/ },
  { label: 'Stripe secret key', name: 'STRIPE_SECRET_KEY', pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { label: 'OpenAI key', name: 'OPENAI_API_KEY', pattern: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { label: 'GitHub token', name: 'GITHUB_TOKEN', pattern: /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { label: 'GitLab token', name: 'GITLAB_TOKEN', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { label: 'Slack token', name: 'SLACK_TOKEN', pattern: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: 'AWS access key', name: 'AWS_ACCESS_KEY_ID', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  { label: 'Google API key', name: 'GOOGLE_API_KEY', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { label: 'npm token', name: 'NPM_TOKEN', pattern: /npm_[A-Za-z0-9]{36}/ },
  { label: 'Hugging Face token', name: 'HF_TOKEN', pattern: /hf_[A-Za-z0-9]{34,}/ },
  { label: 'Resend key', name: 'RESEND_API_KEY', pattern: /re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/ },
  { label: 'private key', name: 'PRIVATE_KEY', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

export type Sighting = { readonly label: string; readonly name: string; readonly value: string };

/** The first credential-shaped value in the text, if any. Earlier, more specific shapes win. */
export function sight(text: string): Sighting | undefined {
  for (const shape of SHAPES) {
    const match = shape.pattern.exec(text);
    if (match) return { label: shape.label, name: shape.name, value: match[0] };
  }
  return undefined;
}
