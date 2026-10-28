CREATE TABLE "agent_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"run_type" text NOT NULL,
	"status" text NOT NULL,
	"retrieved_doc_ids" text[] DEFAULT '{}' NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guardrail_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_provider" text,
	"model_name" text,
	"prompt_version" text,
	"latency_ms" integer,
	"token_usage" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"action_id" text,
	"draft_id" text,
	"reviewer_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"tier" text NOT NULL,
	"country" text NOT NULL,
	"created_at" date NOT NULL,
	"verified" boolean NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'generated' NOT NULL,
	"body" text NOT NULL,
	"citations" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"case_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"input" text NOT NULL,
	"expected" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"eval_run_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"total_cases" integer DEFAULT 0 NOT NULL,
	"metrics" jsonb,
	"case_results" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text NOT NULL,
	"content" text NOT NULL,
	"tsv" "tsvector"
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"doc_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"audience" text NOT NULL,
	"version" text NOT NULL,
	"source_path" text NOT NULL,
	"content" text NOT NULL,
	"checksum" text NOT NULL,
	"trust_status" text DEFAULT 'trusted' NOT NULL,
	"quarantine_reason" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"status" text NOT NULL,
	"placed_at" date NOT NULL,
	"delivered_at" date,
	"eligible_return_until" date,
	"total" integer NOT NULL,
	"currency" text NOT NULL,
	"payment_status" text NOT NULL,
	"tracking_number" text,
	"items" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_reviews" (
	"review_id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"order_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_reviews_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "refund_reviews_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "replacement_orders" (
	"replacement_id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"order_id" text NOT NULL,
	"sku" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replacement_orders_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "replacement_orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "ticket_expected_labels" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"expected" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"order_id" text,
	"channel" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"triage" jsonb,
	"triaged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_actions" (
	"action_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"run_id" text,
	"tool_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"risk_level" text NOT NULL,
	"requires_human_approval" boolean NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"tool_name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"risk_level" text NOT NULL,
	"requires_human_approval" boolean NOT NULL,
	"allowed_categories" text[] NOT NULL,
	"required_fields" text[] NOT NULL,
	"max_amount_inr" integer
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_tool_actions_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."tool_actions"("action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_draft_id_drafts_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("draft_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_ticket_id_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_ticket_id_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_doc_id_kb_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."kb_documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_reviews" ADD CONSTRAINT "refund_reviews_action_id_tool_actions_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."tool_actions"("action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_orders" ADD CONSTRAINT "replacement_orders_action_id_tool_actions_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."tool_actions"("action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_expected_labels" ADD CONSTRAINT "ticket_expected_labels_ticket_id_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_actions" ADD CONSTRAINT "tool_actions_ticket_id_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("ticket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_actions" ADD CONSTRAINT "tool_actions_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_actions" ADD CONSTRAINT "tool_actions_tool_name_tools_tool_name_fk" FOREIGN KEY ("tool_name") REFERENCES "public"."tools"("tool_name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_ticket_idx" ON "agent_runs" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "drafts_ticket_idx" ON "drafts" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_doc_idx" ON "kb_chunks" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tickets_customer_idx" ON "tickets" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_actions_idem_uq" ON "tool_actions" USING btree ("tool_name","idempotency_key");--> statement-breakpoint
CREATE INDEX "tool_actions_ticket_idx" ON "tool_actions" USING btree ("ticket_id");