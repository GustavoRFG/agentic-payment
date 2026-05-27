export type BuyerAuditEventType =
  | "buyer.request_started"
  | "buyer.payment_requirements_received"
  | "buyer.dry_run_completed"
  | "buyer.error";

export interface AuditPaymentSummary {
  network?: string;
  asset?: string;
  amountAtomic?: string;
  amountUsd?: string;
  maxAmountUsd?: string;
}

export interface BuyerAuditEvent {
  eventType: BuyerAuditEventType;
  timestamp?: string;
  requestId: string;
  sellerBaseUrl?: string;
  path?: string;
  method?: string;
  dryRun?: boolean;
  statusCode?: number;
  payment?: AuditPaymentSummary;
  outcome?: "dry_run_no_payment" | "error";
  error?: {
    message: string;
  };
}
