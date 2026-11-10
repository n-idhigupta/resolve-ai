-- Database backstop; case locking serializes API transitions before this constraint.
CREATE UNIQUE INDEX negotiation_one_offered ON "Proposal"("merchantId","caseId") WHERE status='OFFERED';
