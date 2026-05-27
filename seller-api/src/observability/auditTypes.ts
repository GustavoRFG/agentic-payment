export type SellerAuditEventType =
  | "seller.request_received"
  | "seller.payment_required"
  | "seller.report_generated"
  | "seller.response_finished"
  | "seller.error";

export interface AuditPositionSummary {
  protocol?: string;
  chain?: string;
  tokenId?: string;
  pair?: string;
}

export interface AuditPaymentSummary {
  network?: string;
  asset?: string;
  amountAtomic?: string;
  amountUsd?: string;
  mode?: "required" | "accepted";
}

export interface AuditReportSummary {
  reportId?: string;
  mode?: string;
  riskScore?: number;
  riskLevel?: string;
  recommendation?: string;
}

export interface SellerAuditEvent {
  eventType: SellerAuditEventType;
  timestamp?: string;
  requestId: string;
  method?: string;
  path?: string;
  wallet?: string;
  position?: AuditPositionSummary;
  statusCode?: number;
  durationMs?: number;
  payment?: AuditPaymentSummary;
  report?: AuditReportSummary;
  error?: {
    message: string;
  };
}
