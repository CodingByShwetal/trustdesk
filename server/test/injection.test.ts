import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectInjection, KB_RULES } from '../src/modules/guardrails/injection.js';

const dataDir = path.resolve(__dirname, '../../data');
const kbDir = path.join(dataDir, 'knowledge_base');
const tickets = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8')) as Array<{
  ticket_id: string;
  subject: string;
  body: string;
}>;

const ticketText = (id: string) => {
  const t = tickets.find((x) => x.ticket_id === id)!;
  return `${t.subject}\n${t.body}`;
};
const readKb = (file: string) => fs.readFileSync(path.join(kbDir, file), 'utf8');
const rulesOf = (text: string, opts = {}) => [...new Set(detectInjection(text, opts).map((h) => h.rule))].sort();
const kbOpts = { ignoreQuoted: true, rules: KB_RULES };

describe('injection detector: tickets', () => {
  it('flags the identity-bypass request (tkt_9005)', () => {
    expect(rulesOf(ticketText('tkt_9005'))).toEqual(['policy_override', 'verification_bypass']);
  });

  it('flags the hidden coupon injection (tkt_9006)', () => {
    expect(rulesOf(ticketText('tkt_9006'))).toEqual(['hidden_action', 'prompt_injection']);
  });

  it('flags the secret extraction request (tkt_9007)', () => {
    expect(rulesOf(ticketText('tkt_9007'))).toEqual(['secret_exfiltration']);
  });

  it.each(['tkt_9001', 'tkt_9002', 'tkt_9003', 'tkt_9004', 'tkt_9008'])('does not flag benign ticket %s', (id) => {
    expect(detectInjection(ticketText(id))).toEqual([]);
  });
});

describe('injection detector: knowledge base', () => {
  const files = fs.readdirSync(kbDir).filter((f) => f.endsWith('.md'));

  it('flags the adversarial vendor note on every AI-directed rule', () => {
    expect(rulesOf(readKb('adversarial_vendor_note.md'), kbOpts)).toEqual([
      'hidden_action',
      'policy_override',
      'prompt_injection',
      'secret_exfiltration',
    ]);
  });

  it.each(files.filter((f) => f !== 'adversarial_vendor_note.md'))('keeps legitimate policy %s trusted', (file) => {
    expect(detectInjection(readKb(file), kbOpts)).toEqual([]);
  });

  it('relies on ignoring quoted examples to keep the security playbook trusted', () => {
    expect(detectInjection(readKb('support_security_playbook.md')).length).toBeGreaterThan(0);
  });

  it('relies on scoping KB rules to keep the account policy trusted', () => {
    expect(rulesOf(readKb('account_security_policy.md'))).toEqual(['verification_bypass']);
  });
});
