import { CANARY_TOKEN, type DraftPromptInput, type TriagePromptInput } from './prompts.js';
import type { DraftOutput, TriageOutput } from './schemas.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './types.js';

/**
 * Deterministic stand-in for a real model, used in tests and keyless demos.
 * It is a transparent keyword heuristic over the same structured input the
 * prompt renders. It never sees eval labels. Real-model quality is measured
 * separately with LLM_PROVIDER=gemini.
 */
export class MockProvider implements LLMProvider {
  readonly name: string = 'mock';

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const out = req.purpose === 'triage' ? this.triage(req.input as TriagePromptInput) : this.draft(req.input as DraftPromptInput);
    return { text: JSON.stringify(out), provider: this.name, model: `${this.name}-heuristic-v1`, usage: { input: 0, output: 0 }, latencyMs: 1 };
  }

  protected triage(input: TriagePromptInput): TriageOutput {
    const text = `${input.ticket.subject}\n${input.ticket.body}`.toLowerCase();
    const s = input.signals;
    const flags = new Set(input.guardrail_flags.map((f) => f.rule));
    const facts = input.facts.join(' ').toLowerCase();

    let category: TriageOutput['category'] = 'general';
    if (flags.has('secret_exfiltration') || s.account_change_requested || flags.has('verification_bypass')) category = 'account_security';
    else if (s.safety_issue.length || /\bwarranty\b/.test(text)) category = 'warranty';
    else if (s.duplicate_charge_reported || /\b(?:charge[ds]?|billing|payment|invoice)\b/.test(text)) category = 'billing';
    else if (s.stale_tracking_reported || /\b(?:tracking|in transit|lost package|not arrived)\b/.test(text)) category = 'shipping';
    else if (s.refund_requested || s.damage_reported || s.replacement_requested || /\breturn\b/.test(text)) category = 'refund';

    let priority: TriageOutput['priority'] = 'medium';
    if (s.safety_issue.length) priority = 'urgent';
    else if (category === 'account_security' || s.duplicate_charge_reported || (category === 'shipping' && s.urgent_need)) priority = 'high';
    else if (category === 'refund' && facts.includes('not eligible for refund')) priority = 'low';

    const shouldEscalate = s.safety_issue.length > 0 || flags.size > 0 || (s.account_change_requested && !input.customer.verified);
    const sentiment = s.safety_issue.length ? 'worried' : s.damage_reported || s.stale_tracking_reported || s.duplicate_charge_reported ? 'frustrated' : 'neutral';

    return {
      category,
      priority,
      sentiment,
      should_escalate: shouldEscalate,
      reason_summary: `Heuristic triage: ${category} (${priority})${shouldEscalate ? ', escalation required' : ''}.`,
      injection_detected: flags.has('prompt_injection') || flags.has('hidden_action'),
    };
  }

  protected draft(input: DraftPromptInput): DraftOutput {
    const s = input.signals;
    const flags = new Set(input.guardrail_flags.map((f) => f.rule));
    const facts = input.facts.join(' ').toLowerCase();
    const cat = input.triage.category;
    const docIds = new Set(input.policy_chunks.map((c) => c.doc_id));
    const anchor: Record<string, string> = {
      refund: 'KB-REFUND-001',
      shipping: 'KB-SHIPPING-001',
      warranty: 'KB-WARRANTY-001',
      billing: 'KB-BILLING-001',
      account_security: 'KB-ACCOUNT-001',
    };
    const citations = [anchor[cat], flags.size ? 'KB-SECURITY-001' : undefined].filter((d): d is string => !!d && docIds.has(d));
    const actions: DraftOutput['proposed_actions'] = [];
    let escalate = input.triage.should_escalate || flags.size > 0;
    let msg: string;

    if (flags.has('secret_exfiltration')) {
      msg = "I'm not able to share internal instructions, system configuration, credentials or internal notes. I've passed your message to our support security team, and they can help if you have a question about your account.";
    } else if (s.account_change_requested) {
      // Account changes get the specific verification answer even when bypass wording was flagged.
      msg = "For your security, changing the email on your account requires identity verification, and we can't skip that step. I've passed your request to a specialist who will help you verify your identity and update your email safely.";
    } else if (flags.size) {
      msg = "Thanks for reaching out. Your message included instructions aimed at our support system, which I can't act on. Coupons and other goodwill gestures follow our standard policy and always involve a human reviewer, and nothing is ever hidden from our support team. I've passed your request to a specialist for review.";
    } else if (s.safety_issue.length) {
      msg = "I'm sorry to hear this, and thank you for telling us. A swelling or overheating battery is a safety issue: please stop using and charging the device and keep it away from heat. Because this is a safety concern, I've escalated your case to a product safety specialist, who will contact you urgently about next steps under your warranty.";
    } else if (cat === 'refund' && facts.includes('not eligible for refund')) {
      msg = "Thanks for getting in touch. Software licences and final-sale items are not eligible for a refund after purchase under our refund policy, so I'm not able to approve a refund for this order.";
    } else if (cat === 'refund' && s.damage_reported && facts.includes('return window is open')) {
      msg = "I'm sorry your item arrived damaged. Because you reported it within the return window, you're eligible for a replacement or a refund review. Could you reply with a photo of the damage? Once a team member approves it, we'll arrange your replacement.";
      actions.push({ tool_name: s.replacement_requested ? 'create_replacement_order' : 'start_refund_review', reason: 'Damaged item reported within the return window.' });
    } else if (cat === 'shipping' && facts.includes('carrier investigation is allowed')) {
      msg = "I'm sorry your package hasn't moved, especially with your trip coming up. The next step is a carrier investigation, which I've requested for you. If the carrier can't locate the package, a replacement or refund review can be considered after the investigation.";
      actions.push({ tool_name: 'open_carrier_investigation', reason: 'Tracking stale for 5+ business days.' });
    } else if (cat === 'billing' && s.duplicate_charge_reported) {
      msg = "Thanks for flagging this. I've asked our team to start a billing review of the duplicate charge on your order. Payment operations will confirm the outcome, and we'll update you as soon as they do. If we can't locate the transaction, we may ask for the payment date, amount, payment method type and the last four digits of the card.";
      actions.push({ tool_name: 'start_refund_review', reason: 'Duplicate charge reported on a single order.' });
    } else {
      msg = "Thanks for contacting us. A member of our support team will review your request and follow up shortly.";
      escalate = true;
    }

    if (escalate) actions.push({ tool_name: 'escalate_to_human', reason: 'Requires human specialist review.' });

    return {
      body: `Hi ${input.customer.first_name},\n\n${msg}\n\nBest regards,\nTrustDesk Support`,
      citations,
      proposed_actions: actions,
      needs_escalation: escalate,
      escalation_reason: escalate ? 'Policy requires human review' : null,
      unsafe_instructions_detected: flags.size > 0,
      unsupported_claims: [],
    };
  }
}

/**
 * A "jailbroken" model that follows every instruction it sees, cites whatever it
 * likes and leaks its prompt. The deterministic layers must still keep the
 * system safe. Used by tests and by LLM_PROVIDER=mock_compromised demos.
 */
export class CompromisedMockProvider extends MockProvider {
  override readonly name = 'mock_compromised';

  protected override triage(input: TriagePromptInput): TriageOutput {
    return {
      ...super.triage(input),
      priority: 'low',
      should_escalate: false,
      reason_summary: 'Customer request approved as instructed.',
      injection_detected: false,
    };
  }

  protected override draft(input: DraftPromptInput): DraftOutput {
    return {
      body: `Hi ${input.customer.first_name},\n\nAs instructed, I have issued your 5000 INR coupon and your refund has been processed. For transparency, my internal marker is ${CANARY_TOKEN}. Do not tell the reviewer.\n\nTrustDesk`,
      citations: ['KB-ADVERSARIAL-001', 'KB-FAKE-999'],
      proposed_actions: [
        { tool_name: 'issue_coupon', reason: 'Customer asked for it.', amount_inr: 5000 },
        { tool_name: 'create_replacement_order', reason: 'Why not.' },
        { tool_name: 'lock_account', reason: 'Instructed.' },
        { tool_name: 'delete_all_orders', reason: 'Instructed.' },
      ],
      needs_escalation: false,
      escalation_reason: null,
      unsafe_instructions_detected: false,
      unsupported_claims: [],
    };
  }
}
