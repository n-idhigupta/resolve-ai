-- Generated relational foundation. Supplemental guards live in migration 0002.
CREATE TYPE "Role" AS ENUM ('OWNER','APPROVER','AGENT');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE','DISABLED');
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE','SUSPENDED');
CREATE TYPE "OrderStatus" AS ENUM ('UNPAID','PENDING','PAID','CANCELLED');
CREATE TYPE "OperationKind" AS ENUM ('CREATE','CAPTURE');
CREATE TYPE "OperationState" AS ENUM ('READY','IN_FLIGHT','PENDING','UNKNOWN','COMPLETED','FAILED');
CREATE TYPE "CaseStatus" AS ENUM ('OPEN','INVESTIGATING','NEGOTIATING','RESOLUTION_PENDING','RESOLVED','ESCALATED','CLOSED_WITHOUT_AGREEMENT');
CREATE TYPE "ComplaintReason" AS ENUM ('ITEM_NOT_RECEIVED','NOT_AS_DESCRIBED','DAMAGED','DUPLICATE_CHARGE','OTHER');
CREATE TYPE "EvidenceState" AS ENUM ('QUARANTINED','CLEAN','REJECTED','FAILED');
CREATE TYPE "ExtractionState" AS ENUM ('PENDING','SUCCEEDED','FAILED');
CREATE TYPE "AnalysisState" AS ENUM ('QUEUED','RUNNING','SUCCEEDED','NEEDS_REVIEW','FAILED','STALE');
CREATE TYPE "ProposalKind" AS ENUM ('FULL_REFUND','PARTIAL_REFUND','REPLACEMENT','REQUEST_EVIDENCE','ESCALATION');
CREATE TYPE "ProposalState" AS ENUM ('DRAFT','OFFERED','AGREED','EXECUTING','FULFILLED','REJECTED','EXPIRED','SUPERSEDED');
CREATE TYPE "ActorRole" AS ENUM ('CUSTOMER','MERCHANT');
CREATE TYPE "Decision" AS ENUM ('ACCEPT','REJECT');
CREATE TYPE "VerificationState" AS ENUM ('UNVERIFIED','VERIFIED','REJECTED');
CREATE TYPE "ProcessingState" AS ENUM ('PENDING','PROCESSED','FAILED');
CREATE TYPE "ReconciliationState" AS ENUM ('CURRENT','FROZEN');
CREATE TABLE "Merchant" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"name" TEXT NOT NULL,
"status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
"defaultCurrency" TEXT NOT NULL DEFAULT 'USD');
CREATE TABLE "User" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"normalizedEmail" TEXT NOT NULL,
"passwordHash" TEXT NOT NULL,
"status" "UserStatus" NOT NULL DEFAULT 'ACTIVE');
CREATE UNIQUE INDEX "User_unique_0" ON "User" ("normalizedEmail");
CREATE TABLE "Session" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"userId" UUID NOT NULL,
"tokenHash" TEXT NOT NULL,
"authenticatedAt" TIMESTAMPTZ(3) NOT NULL,
"expiresAt" TIMESTAMPTZ(3) NOT NULL,
"lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
"revokedAt" TIMESTAMPTZ(3));
CREATE UNIQUE INDEX "Session_unique_0" ON "Session" ("tokenHash");
CREATE TABLE "Membership" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"userId" UUID NOT NULL,
"role" "Role" NOT NULL,
"active" BOOLEAN NOT NULL DEFAULT true);
CREATE UNIQUE INDEX "Membership_unique_0" ON "Membership" ("merchantId","id");
CREATE UNIQUE INDEX "Membership_unique_1" ON "Membership" ("merchantId","userId");
CREATE TABLE "PaymentAccount" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"environment" TEXT NOT NULL,
"providerMerchantId" TEXT NOT NULL,
"credentialSecretRef" TEXT NOT NULL,
"webhookId" TEXT,
"accountKey" TEXT NOT NULL);
CREATE UNIQUE INDEX "PaymentAccount_unique_0" ON "PaymentAccount" ("merchantId","id");
CREATE UNIQUE INDEX "PaymentAccount_unique_1" ON "PaymentAccount" ("environment","providerMerchantId");
CREATE UNIQUE INDEX "PaymentAccount_unique_2" ON "PaymentAccount" ("accountKey");
CREATE TABLE "PolicyVersion" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"sequence" INTEGER NOT NULL,
"contentHash" TEXT NOT NULL,
"effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
"publishedAt" TIMESTAMPTZ(3));
CREATE UNIQUE INDEX "PolicyVersion_unique_0" ON "PolicyVersion" ("merchantId","id");
CREATE UNIQUE INDEX "PolicyVersion_unique_1" ON "PolicyVersion" ("merchantId","sequence");
CREATE TABLE "PolicyClause" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"policyVersionId" UUID NOT NULL,
"clauseKey" TEXT NOT NULL,
"text" TEXT NOT NULL,
"rulesJson" JSONB NOT NULL);
CREATE UNIQUE INDEX "PolicyClause_unique_0" ON "PolicyClause" ("merchantId","id");
CREATE UNIQUE INDEX "PolicyClause_unique_1" ON "PolicyClause" ("merchantId","policyVersionId","clauseKey");
CREATE TABLE "Order" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"customerUserId" UUID NOT NULL,
"purchasePolicyVersionId" UUID NOT NULL,
"merchantReference" TEXT NOT NULL,
"amountMinor" BIGINT NOT NULL,
"currency" TEXT NOT NULL,
"status" "OrderStatus" NOT NULL DEFAULT 'UNPAID',
"version" INTEGER NOT NULL DEFAULT 0,
"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "Order_unique_0" ON "Order" ("merchantId","id");
CREATE UNIQUE INDEX "Order_unique_1" ON "Order" ("merchantId","merchantReference");
CREATE TABLE "CustomerOrder" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"orderId" UUID NOT NULL,
"userId" UUID NOT NULL);
CREATE UNIQUE INDEX "CustomerOrder_unique_0" ON "CustomerOrder" ("merchantId","id");
CREATE UNIQUE INDEX "CustomerOrder_unique_1" ON "CustomerOrder" ("merchantId","orderId","userId");
CREATE TABLE "OrderItem" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"orderId" UUID NOT NULL,
"description" TEXT NOT NULL,
"quantity" INTEGER NOT NULL,
"unitMinor" BIGINT NOT NULL,
"taxMinor" BIGINT NOT NULL DEFAULT 0,
"shippingMinor" BIGINT NOT NULL DEFAULT 0,
"currency" TEXT NOT NULL);
CREATE UNIQUE INDEX "OrderItem_unique_0" ON "OrderItem" ("merchantId","id");
CREATE TABLE "CheckoutOperation" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"orderId" UUID NOT NULL,
"accountId" UUID NOT NULL,
"kind" "OperationKind" NOT NULL,
"requestId" UUID NOT NULL,
"requestHash" TEXT NOT NULL,
"providerOrderId" TEXT,
"state" "OperationState" NOT NULL DEFAULT 'READY',
"attemptCount" INTEGER NOT NULL DEFAULT 0,
"leaseOwner" TEXT,
"leaseUntil" TIMESTAMPTZ(3),
"nextAttemptAt" TIMESTAMPTZ(3),
"completedAt" TIMESTAMPTZ(3),
"lastErrorCode" TEXT,
"version" INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX "CheckoutOperation_unique_0" ON "CheckoutOperation" ("merchantId","id");
CREATE UNIQUE INDEX "CheckoutOperation_unique_1" ON "CheckoutOperation" ("accountId","requestId");
CREATE TABLE "Capture" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"orderId" UUID NOT NULL,
"accountId" UUID NOT NULL,
"providerCaptureId" TEXT NOT NULL,
"providerOrderId" TEXT NOT NULL,
"grossMinor" BIGINT NOT NULL,
"currency" TEXT NOT NULL,
"providerStatus" TEXT NOT NULL,
"completedAt" TIMESTAMPTZ(3) NOT NULL,
"reservedMinor" BIGINT NOT NULL DEFAULT 0,
"refundedMinor" BIGINT NOT NULL DEFAULT 0,
"externalRefundedMinor" BIGINT NOT NULL DEFAULT 0,
"reconciliationStatus" "ReconciliationState" NOT NULL DEFAULT 'CURRENT',
"discrepancyJson" JSONB,
"version" INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX "Capture_unique_0" ON "Capture" ("merchantId","id");
CREATE UNIQUE INDEX "Capture_unique_1" ON "Capture" ("accountId","providerCaptureId");
CREATE UNIQUE INDEX "Capture_unique_2" ON "Capture" ("merchantId","orderId");
CREATE UNIQUE INDEX "Capture_unique_3" ON "Capture" ("merchantId","id","orderId");
CREATE UNIQUE INDEX "Capture_unique_4" ON "Capture" ("merchantId","id","accountId");
CREATE TABLE "Case" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"orderId" UUID NOT NULL,
"openedBy" UUID NOT NULL,
"policyVersionId" UUID NOT NULL,
"reason" "ComplaintReason" NOT NULL,
"description" TEXT NOT NULL,
"status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
"currentProposalId" UUID,
"dataRevision" INTEGER NOT NULL DEFAULT 0,
"version" INTEGER NOT NULL DEFAULT 0,
"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"resolvedAt" TIMESTAMPTZ(3));
CREATE UNIQUE INDEX "Case_unique_0" ON "Case" ("merchantId","id");
CREATE UNIQUE INDEX "Case_unique_1" ON "Case" ("merchantId","id","orderId");
CREATE TABLE "Evidence" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"caseId" UUID NOT NULL,
"uploaderUserId" UUID NOT NULL,
"objectKey" TEXT NOT NULL,
"objectVersion" TEXT,
"filename" TEXT NOT NULL,
"detectedType" TEXT,
"sizeBytes" BIGINT NOT NULL,
"sha256" TEXT NOT NULL,
"scanStatus" "EvidenceState" NOT NULL DEFAULT 'QUARANTINED',
"extractionStatus" "ExtractionState" NOT NULL DEFAULT 'PENDING');
CREATE UNIQUE INDEX "Evidence_unique_0" ON "Evidence" ("merchantId","id");
CREATE UNIQUE INDEX "Evidence_unique_1" ON "Evidence" ("objectKey");
CREATE TABLE "EvidenceChunk" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"evidenceId" UUID NOT NULL,
"ordinal" INTEGER NOT NULL,
"page" INTEGER,
"charStart" INTEGER NOT NULL,
"charEnd" INTEGER NOT NULL,
"textHash" TEXT NOT NULL,
"sanitizedText" TEXT NOT NULL);
CREATE UNIQUE INDEX "EvidenceChunk_unique_0" ON "EvidenceChunk" ("merchantId","id");
CREATE UNIQUE INDEX "EvidenceChunk_unique_1" ON "EvidenceChunk" ("merchantId","evidenceId","ordinal");
CREATE TABLE "Analysis" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"caseId" UUID NOT NULL,
"snapshotHash" TEXT NOT NULL,
"snapshotJson" JSONB NOT NULL,
"modelId" TEXT NOT NULL,
"promptVersion" TEXT NOT NULL,
"schemaVersion" TEXT NOT NULL,
"policyEngineVersion" TEXT NOT NULL,
"status" "AnalysisState" NOT NULL DEFAULT 'QUEUED',
"reviewReasons" JSONB NOT NULL,
"latencyMs" INTEGER,
"tokenUsage" JSONB);
CREATE UNIQUE INDEX "Analysis_unique_0" ON "Analysis" ("merchantId","id");
CREATE TABLE "Finding" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"analysisId" UUID NOT NULL,
"kind" TEXT NOT NULL,
"statement" TEXT NOT NULL,
"certaintyBand" TEXT NOT NULL,
"reviewStatus" TEXT NOT NULL);
CREATE UNIQUE INDEX "Finding_unique_0" ON "Finding" ("merchantId","id");
CREATE TABLE "FindingReference" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"findingId" UUID NOT NULL,
"evidenceChunkId" UUID,
"orderId" UUID,
"captureId" UUID,
"policyClauseId" UUID,
"recordField" TEXT,
"start" INTEGER,
"end" INTEGER,
"quoteHash" TEXT);
CREATE UNIQUE INDEX "FindingReference_unique_0" ON "FindingReference" ("merchantId","id");
CREATE TABLE "Proposal" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"caseId" UUID NOT NULL,
"orderId" UUID NOT NULL,
"analysisId" UUID,
"policyVersionId" UUID NOT NULL,
"sequence" INTEGER NOT NULL,
"supersedesId" UUID,
"kind" "ProposalKind" NOT NULL,
"amountMinor" BIGINT,
"currency" TEXT,
"termsJson" JSONB NOT NULL,
"contentHash" TEXT NOT NULL,
"expiresAt" TIMESTAMPTZ(3) NOT NULL,
"status" "ProposalState" NOT NULL DEFAULT 'DRAFT',
"rowVersion" INTEGER NOT NULL DEFAULT 0,
"completedAt" TIMESTAMPTZ(3));
CREATE UNIQUE INDEX "Proposal_unique_0" ON "Proposal" ("merchantId","id");
CREATE UNIQUE INDEX "Proposal_unique_1" ON "Proposal" ("merchantId","caseId","sequence");
CREATE UNIQUE INDEX "Proposal_unique_2" ON "Proposal" ("merchantId","id","caseId");
CREATE UNIQUE INDEX "Proposal_unique_3" ON "Proposal" ("merchantId","id","orderId");
CREATE TABLE "Approval" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"proposalId" UUID NOT NULL,
"actorUserId" UUID NOT NULL,
"actorRole" "ActorRole" NOT NULL,
"decision" "Decision" NOT NULL,
"contentHash" TEXT NOT NULL,
"policyVersionId" UUID NOT NULL,
"decidedAt" TIMESTAMPTZ(3) NOT NULL,
"authenticationContext" JSONB NOT NULL);
CREATE UNIQUE INDEX "Approval_unique_0" ON "Approval" ("merchantId","id");
CREATE TABLE "RefundOperation" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"captureId" UUID NOT NULL,
"proposalId" UUID NOT NULL,
"orderId" UUID NOT NULL,
"accountId" UUID NOT NULL,
"amountMinor" BIGINT NOT NULL,
"currency" TEXT NOT NULL,
"providerRequestId" UUID NOT NULL,
"requestHash" TEXT NOT NULL,
"providerRefundId" TEXT,
"state" "OperationState" NOT NULL DEFAULT 'READY',
"attemptCount" INTEGER NOT NULL DEFAULT 0,
"leaseOwner" TEXT,
"leaseUntil" TIMESTAMPTZ(3),
"nextAttemptAt" TIMESTAMPTZ(3),
"lastErrorCode" TEXT,
"version" INTEGER NOT NULL DEFAULT 0,
"completedAt" TIMESTAMPTZ(3),
"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "RefundOperation_unique_0" ON "RefundOperation" ("merchantId","id");
CREATE UNIQUE INDEX "RefundOperation_unique_1" ON "RefundOperation" ("merchantId","proposalId");
CREATE UNIQUE INDEX "RefundOperation_unique_2" ON "RefundOperation" ("accountId","providerRequestId");
CREATE UNIQUE INDEX "RefundOperation_unique_3" ON "RefundOperation" ("accountId","providerRefundId");
CREATE TABLE "PaymentAttempt" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"refundOperationId" UUID,
"checkoutOperationId" UUID,
"attemptNo" INTEGER NOT NULL,
"requestHash" TEXT NOT NULL,
"startedAt" TIMESTAMPTZ(3) NOT NULL,
"finishedAt" TIMESTAMPTZ(3),
"transportOutcome" TEXT,
"providerDebugId" TEXT);
CREATE UNIQUE INDEX "PaymentAttempt_unique_0" ON "PaymentAttempt" ("merchantId","id");
CREATE TABLE "ExternalRefund" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"captureId" UUID NOT NULL,
"accountId" UUID NOT NULL,
"providerRefundId" TEXT NOT NULL,
"amountMinor" BIGINT NOT NULL,
"currency" TEXT NOT NULL,
"state" "OperationState" NOT NULL,
"completedAt" TIMESTAMPTZ(3));
CREATE UNIQUE INDEX "ExternalRefund_unique_0" ON "ExternalRefund" ("merchantId","id");
CREATE UNIQUE INDEX "ExternalRefund_unique_1" ON "ExternalRefund" ("accountId","providerRefundId");
CREATE TABLE "FormalDispute" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"caseId" UUID,
"accountId" UUID NOT NULL,
"providerDisputeId" TEXT NOT NULL,
"state" TEXT NOT NULL,
"lastSyncedAt" TIMESTAMPTZ(3));
CREATE UNIQUE INDEX "FormalDispute_unique_0" ON "FormalDispute" ("merchantId","id");
CREATE UNIQUE INDEX "FormalDispute_unique_1" ON "FormalDispute" ("accountId","providerDisputeId");
CREATE TABLE "WebhookInbox" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"accountId" UUID NOT NULL,
"providerEventId" TEXT NOT NULL,
"verificationStatus" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
"processingStatus" "ProcessingState" NOT NULL DEFAULT 'PENDING',
"attempts" INTEGER NOT NULL DEFAULT 0,
"receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "WebhookInbox_unique_0" ON "WebhookInbox" ("merchantId","id");
CREATE UNIQUE INDEX "WebhookInbox_unique_1" ON "WebhookInbox" ("accountId","providerEventId");
CREATE TABLE "WebhookReceipt" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"inboxId" UUID NOT NULL,
"originalPayloadEncryptedRef" TEXT NOT NULL,
"payloadHash" TEXT NOT NULL,
"redactedHeaders" JSONB NOT NULL,
"verificationStatus" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
"receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "WebhookReceipt_unique_0" ON "WebhookReceipt" ("merchantId","id");
CREATE TABLE "AuditEvent" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"aggregateType" TEXT NOT NULL,
"aggregateId" UUID NOT NULL,
"actorType" TEXT NOT NULL,
"actorId" UUID,
"action" TEXT NOT NULL,
"visibility" TEXT NOT NULL,
"correlationId" TEXT NOT NULL,
"redactedMetadata" JSONB NOT NULL,
"occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "AuditEvent_unique_0" ON "AuditEvent" ("merchantId","id");
CREATE TABLE "OutboxEvent" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"aggregateType" TEXT NOT NULL,
"aggregateId" UUID NOT NULL,
"eventType" TEXT NOT NULL,
"schemaVersion" INTEGER NOT NULL,
"payloadIds" JSONB NOT NULL,
"dedupeKey" TEXT NOT NULL,
"availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"leaseUntil" TIMESTAMPTZ(3),
"deliveredAt" TIMESTAMPTZ(3),
"attempts" INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX "OutboxEvent_unique_0" ON "OutboxEvent" ("merchantId","id");
CREATE UNIQUE INDEX "OutboxEvent_unique_1" ON "OutboxEvent" ("merchantId","dedupeKey");
CREATE TABLE "IdempotencyRecord" ("id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
"merchantId" UUID NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"actorId" UUID NOT NULL,
"routeScope" TEXT NOT NULL,
"key" TEXT NOT NULL,
"requestHash" TEXT NOT NULL,
"operationId" UUID,
"resultRef" JSONB,
"expiresAt" TIMESTAMPTZ(3) NOT NULL);
CREATE UNIQUE INDEX "IdempotencyRecord_unique_0" ON "IdempotencyRecord" ("merchantId","id");
CREATE UNIQUE INDEX "IdempotencyRecord_unique_1" ON "IdempotencyRecord" ("merchantId","actorId","routeScope","key");
ALTER TABLE "Membership" ADD CONSTRAINT "fk_Membership_0" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_0" ON "Membership" ("merchantId");
ALTER TABLE "PaymentAccount" ADD CONSTRAINT "fk_PaymentAccount_1" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_1" ON "PaymentAccount" ("merchantId");
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "fk_PolicyVersion_2" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_2" ON "PolicyVersion" ("merchantId");
ALTER TABLE "PolicyClause" ADD CONSTRAINT "fk_PolicyClause_3" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_3" ON "PolicyClause" ("merchantId");
ALTER TABLE "Order" ADD CONSTRAINT "fk_Order_4" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_4" ON "Order" ("merchantId");
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "fk_CustomerOrder_5" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_5" ON "CustomerOrder" ("merchantId");
ALTER TABLE "OrderItem" ADD CONSTRAINT "fk_OrderItem_6" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_6" ON "OrderItem" ("merchantId");
ALTER TABLE "CheckoutOperation" ADD CONSTRAINT "fk_CheckoutOperation_7" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_7" ON "CheckoutOperation" ("merchantId");
ALTER TABLE "Capture" ADD CONSTRAINT "fk_Capture_8" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_8" ON "Capture" ("merchantId");
ALTER TABLE "Case" ADD CONSTRAINT "fk_Case_9" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_9" ON "Case" ("merchantId");
ALTER TABLE "Evidence" ADD CONSTRAINT "fk_Evidence_10" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_10" ON "Evidence" ("merchantId");
ALTER TABLE "EvidenceChunk" ADD CONSTRAINT "fk_EvidenceChunk_11" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_11" ON "EvidenceChunk" ("merchantId");
ALTER TABLE "Analysis" ADD CONSTRAINT "fk_Analysis_12" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_12" ON "Analysis" ("merchantId");
ALTER TABLE "Finding" ADD CONSTRAINT "fk_Finding_13" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_13" ON "Finding" ("merchantId");
ALTER TABLE "FindingReference" ADD CONSTRAINT "fk_FindingReference_14" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_14" ON "FindingReference" ("merchantId");
ALTER TABLE "Proposal" ADD CONSTRAINT "fk_Proposal_15" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_15" ON "Proposal" ("merchantId");
ALTER TABLE "Approval" ADD CONSTRAINT "fk_Approval_16" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_16" ON "Approval" ("merchantId");
ALTER TABLE "RefundOperation" ADD CONSTRAINT "fk_RefundOperation_17" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_17" ON "RefundOperation" ("merchantId");
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "fk_PaymentAttempt_18" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_18" ON "PaymentAttempt" ("merchantId");
ALTER TABLE "ExternalRefund" ADD CONSTRAINT "fk_ExternalRefund_19" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_19" ON "ExternalRefund" ("merchantId");
ALTER TABLE "FormalDispute" ADD CONSTRAINT "fk_FormalDispute_20" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_20" ON "FormalDispute" ("merchantId");
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "fk_WebhookInbox_21" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_21" ON "WebhookInbox" ("merchantId");
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "fk_WebhookReceipt_22" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_22" ON "WebhookReceipt" ("merchantId");
ALTER TABLE "AuditEvent" ADD CONSTRAINT "fk_AuditEvent_23" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_23" ON "AuditEvent" ("merchantId");
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "fk_OutboxEvent_24" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_24" ON "OutboxEvent" ("merchantId");
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "fk_IdempotencyRecord_25" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_25" ON "IdempotencyRecord" ("merchantId");
ALTER TABLE "Session" ADD CONSTRAINT "fk_Session_26" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_26" ON "Session" ("userId");
ALTER TABLE "Membership" ADD CONSTRAINT "fk_Membership_27" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_27" ON "Membership" ("userId");
ALTER TABLE "Order" ADD CONSTRAINT "fk_Order_28" FOREIGN KEY ("customerUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_28" ON "Order" ("customerUserId");
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "fk_CustomerOrder_29" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_29" ON "CustomerOrder" ("userId");
ALTER TABLE "Case" ADD CONSTRAINT "fk_Case_30" FOREIGN KEY ("openedBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_30" ON "Case" ("openedBy");
ALTER TABLE "Evidence" ADD CONSTRAINT "fk_Evidence_31" FOREIGN KEY ("uploaderUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_31" ON "Evidence" ("uploaderUserId");
ALTER TABLE "Approval" ADD CONSTRAINT "fk_Approval_32" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_32" ON "Approval" ("actorUserId");
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "fk_IdempotencyRecord_33" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_33" ON "IdempotencyRecord" ("actorId");
ALTER TABLE "PolicyClause" ADD CONSTRAINT "fk_PolicyClause_34" FOREIGN KEY ("merchantId","policyVersionId") REFERENCES "PolicyVersion" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_34" ON "PolicyClause" ("merchantId","policyVersionId");
ALTER TABLE "Order" ADD CONSTRAINT "fk_Order_35" FOREIGN KEY ("merchantId","purchasePolicyVersionId") REFERENCES "PolicyVersion" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_35" ON "Order" ("merchantId","purchasePolicyVersionId");
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "fk_CustomerOrder_36" FOREIGN KEY ("merchantId","orderId") REFERENCES "Order" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_36" ON "CustomerOrder" ("merchantId","orderId");
ALTER TABLE "OrderItem" ADD CONSTRAINT "fk_OrderItem_37" FOREIGN KEY ("merchantId","orderId") REFERENCES "Order" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_37" ON "OrderItem" ("merchantId","orderId");
ALTER TABLE "CheckoutOperation" ADD CONSTRAINT "fk_CheckoutOperation_38" FOREIGN KEY ("merchantId","orderId") REFERENCES "Order" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_38" ON "CheckoutOperation" ("merchantId","orderId");
ALTER TABLE "CheckoutOperation" ADD CONSTRAINT "fk_CheckoutOperation_39" FOREIGN KEY ("merchantId","accountId") REFERENCES "PaymentAccount" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_39" ON "CheckoutOperation" ("merchantId","accountId");
ALTER TABLE "Capture" ADD CONSTRAINT "fk_Capture_40" FOREIGN KEY ("merchantId","orderId") REFERENCES "Order" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_40" ON "Capture" ("merchantId","orderId");
ALTER TABLE "Capture" ADD CONSTRAINT "fk_Capture_41" FOREIGN KEY ("merchantId","accountId") REFERENCES "PaymentAccount" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_41" ON "Capture" ("merchantId","accountId");
ALTER TABLE "Case" ADD CONSTRAINT "fk_Case_42" FOREIGN KEY ("merchantId","orderId") REFERENCES "Order" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_42" ON "Case" ("merchantId","orderId");
ALTER TABLE "Case" ADD CONSTRAINT "fk_Case_43" FOREIGN KEY ("merchantId","policyVersionId") REFERENCES "PolicyVersion" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_43" ON "Case" ("merchantId","policyVersionId");
ALTER TABLE "Evidence" ADD CONSTRAINT "fk_Evidence_44" FOREIGN KEY ("merchantId","caseId") REFERENCES "Case" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_44" ON "Evidence" ("merchantId","caseId");
ALTER TABLE "EvidenceChunk" ADD CONSTRAINT "fk_EvidenceChunk_45" FOREIGN KEY ("merchantId","evidenceId") REFERENCES "Evidence" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_45" ON "EvidenceChunk" ("merchantId","evidenceId");
ALTER TABLE "Analysis" ADD CONSTRAINT "fk_Analysis_46" FOREIGN KEY ("merchantId","caseId") REFERENCES "Case" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_46" ON "Analysis" ("merchantId","caseId");
ALTER TABLE "Finding" ADD CONSTRAINT "fk_Finding_47" FOREIGN KEY ("merchantId","analysisId") REFERENCES "Analysis" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_47" ON "Finding" ("merchantId","analysisId");
ALTER TABLE "FindingReference" ADD CONSTRAINT "fk_FindingReference_48" FOREIGN KEY ("merchantId","findingId") REFERENCES "Finding" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_48" ON "FindingReference" ("merchantId","findingId");
ALTER TABLE "FindingReference" ADD CONSTRAINT "fk_FindingReference_49" FOREIGN KEY ("merchantId","evidenceChunkId") REFERENCES "EvidenceChunk" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_49" ON "FindingReference" ("merchantId","evidenceChunkId");
ALTER TABLE "FindingReference" ADD CONSTRAINT "fk_FindingReference_50" FOREIGN KEY ("merchantId","orderId") REFERENCES "Order" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_50" ON "FindingReference" ("merchantId","orderId");
ALTER TABLE "FindingReference" ADD CONSTRAINT "fk_FindingReference_51" FOREIGN KEY ("merchantId","captureId") REFERENCES "Capture" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_51" ON "FindingReference" ("merchantId","captureId");
ALTER TABLE "FindingReference" ADD CONSTRAINT "fk_FindingReference_52" FOREIGN KEY ("merchantId","policyClauseId") REFERENCES "PolicyClause" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_52" ON "FindingReference" ("merchantId","policyClauseId");
ALTER TABLE "Proposal" ADD CONSTRAINT "fk_Proposal_53" FOREIGN KEY ("merchantId","analysisId") REFERENCES "Analysis" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_53" ON "Proposal" ("merchantId","analysisId");
ALTER TABLE "Proposal" ADD CONSTRAINT "fk_Proposal_54" FOREIGN KEY ("merchantId","policyVersionId") REFERENCES "PolicyVersion" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_54" ON "Proposal" ("merchantId","policyVersionId");
ALTER TABLE "Proposal" ADD CONSTRAINT "fk_Proposal_55" FOREIGN KEY ("merchantId","supersedesId") REFERENCES "Proposal" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_55" ON "Proposal" ("merchantId","supersedesId");
ALTER TABLE "Approval" ADD CONSTRAINT "fk_Approval_56" FOREIGN KEY ("merchantId","proposalId") REFERENCES "Proposal" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_56" ON "Approval" ("merchantId","proposalId");
ALTER TABLE "Approval" ADD CONSTRAINT "fk_Approval_57" FOREIGN KEY ("merchantId","policyVersionId") REFERENCES "PolicyVersion" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_57" ON "Approval" ("merchantId","policyVersionId");
ALTER TABLE "RefundOperation" ADD CONSTRAINT "fk_RefundOperation_58" FOREIGN KEY ("merchantId","accountId") REFERENCES "PaymentAccount" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_58" ON "RefundOperation" ("merchantId","accountId");
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "fk_PaymentAttempt_59" FOREIGN KEY ("merchantId","refundOperationId") REFERENCES "RefundOperation" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_59" ON "PaymentAttempt" ("merchantId","refundOperationId");
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "fk_PaymentAttempt_60" FOREIGN KEY ("merchantId","checkoutOperationId") REFERENCES "CheckoutOperation" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_60" ON "PaymentAttempt" ("merchantId","checkoutOperationId");
ALTER TABLE "ExternalRefund" ADD CONSTRAINT "fk_ExternalRefund_61" FOREIGN KEY ("merchantId","captureId") REFERENCES "Capture" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_61" ON "ExternalRefund" ("merchantId","captureId");
ALTER TABLE "ExternalRefund" ADD CONSTRAINT "fk_ExternalRefund_62" FOREIGN KEY ("merchantId","accountId") REFERENCES "PaymentAccount" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_62" ON "ExternalRefund" ("merchantId","accountId");
ALTER TABLE "FormalDispute" ADD CONSTRAINT "fk_FormalDispute_63" FOREIGN KEY ("merchantId","caseId") REFERENCES "Case" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_63" ON "FormalDispute" ("merchantId","caseId");
ALTER TABLE "FormalDispute" ADD CONSTRAINT "fk_FormalDispute_64" FOREIGN KEY ("merchantId","accountId") REFERENCES "PaymentAccount" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_64" ON "FormalDispute" ("merchantId","accountId");
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "fk_WebhookInbox_65" FOREIGN KEY ("merchantId","accountId") REFERENCES "PaymentAccount" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_65" ON "WebhookInbox" ("merchantId","accountId");
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "fk_WebhookReceipt_66" FOREIGN KEY ("merchantId","inboxId") REFERENCES "WebhookInbox" ("merchantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_66" ON "WebhookReceipt" ("merchantId","inboxId");
ALTER TABLE "Proposal" ADD CONSTRAINT "fk_Proposal_67" FOREIGN KEY ("merchantId","caseId","orderId") REFERENCES "Case" ("merchantId","id","orderId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_67" ON "Proposal" ("merchantId","caseId","orderId");
ALTER TABLE "Case" ADD CONSTRAINT "fk_Case_68" FOREIGN KEY ("merchantId","currentProposalId","id") REFERENCES "Proposal" ("merchantId","id","caseId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_68" ON "Case" ("merchantId","currentProposalId","id");
ALTER TABLE "RefundOperation" ADD CONSTRAINT "fk_RefundOperation_69" FOREIGN KEY ("merchantId","captureId","orderId") REFERENCES "Capture" ("merchantId","id","orderId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_69" ON "RefundOperation" ("merchantId","captureId","orderId");
ALTER TABLE "RefundOperation" ADD CONSTRAINT "fk_RefundOperation_70" FOREIGN KEY ("merchantId","captureId","accountId") REFERENCES "Capture" ("merchantId","id","accountId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_70" ON "RefundOperation" ("merchantId","captureId","accountId");
ALTER TABLE "RefundOperation" ADD CONSTRAINT "fk_RefundOperation_71" FOREIGN KEY ("merchantId","proposalId","orderId") REFERENCES "Proposal" ("merchantId","id","orderId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "idx_fk_71" ON "RefundOperation" ("merchantId","proposalId","orderId");
