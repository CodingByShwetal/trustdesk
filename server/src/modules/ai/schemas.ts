import { z } from 'zod';

export const CATEGORIES = ['shipping', 'refund', 'warranty', 'billing', 'account_security', 'general'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export const TriageOutput = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  sentiment: z.string().trim().min(1).max(30),
  should_escalate: z.boolean(),
  reason_summary: z.string().trim().min(1).max(500),
  injection_detected: z.boolean().default(false),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const DraftOutput = z.object({
  body: z.string().trim().min(1).max(4000),
  citations: z.array(z.string().trim().min(1).max(64)).max(10),
  proposed_actions: z
    .array(
      z.object({
        tool_name: z.string().trim().min(1).max(64),
        reason: z.string().trim().min(1).max(400),
        amount_inr: z.number().nonnegative().optional(),
      }),
    )
    .max(5)
    .default([]),
  needs_escalation: z.boolean(),
  escalation_reason: z.string().max(400).nullable().default(null),
  unsafe_instructions_detected: z.boolean().default(false),
  unsupported_claims: z.array(z.string().max(300)).max(10).default([]),
});
export type DraftOutput = z.infer<typeof DraftOutput>;
