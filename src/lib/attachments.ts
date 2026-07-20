export interface UploadedAttachment {
  id: string;
  name: string;
  url?: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface AttachmentDraft {
  localId: string;
  file: File;
  mode: "understand" | "verify";
  instruction: string;
  expectedIntent: string;
  uploaded?: UploadedAttachment;
}

export interface AttachmentAnalysisItem {
  attachment_id: string;
  name?: string;
  url?: string;
  media_type?: string;
  size_bytes?: number;
  status: string;
  recognition_status?: "recognized" | "not-recognized";
  recognition_reason?:
    | "model_returned_grounded_attachment_observation"
    | "model_did_not_observe_attachment"
    | "model_returned_invalid_response"
    | "upstream_returned_invalid_json"
    | "upstream_request_failed"
    | "attachment_not_found"
    | "attachment_analysis_failed"
    | string;
  requested_model?: string;
  analysis_model?: string;
  model_fallback?: boolean;
  model_fallback_reason?: string | null;
  requested_protocol?: string;
  analysis_protocol?: string;
  protocol_fallback?: boolean;
  protocol_fallback_reason?: string | null;
  analysis_attempts?: number;
  upstream_message_id?: string | null;
  delivery_mode?: "native" | "extracted" | "sampled" | "byte-summary" | null;
  coverage_percent?: number | null;
  format_retry?: boolean;
  native_optimized?: boolean;
  transmitted_media_type?: string | null;
  transmitted_size_bytes?: number | null;
  analysis?: {
    attachment_received?: boolean;
    attachment_type?: "image" | "document" | "source_code" | "structured_data" | "text" | "archive" | "other" | "unknown" | string;
    observation?: string;
    observable_content?: string;
    extracted_text?: string;
    likely_purpose?: string;
    evidence?: string[];
    alternatives?: string[];
    confidence?: number | null;
    limitations?: string[];
  } | null;
  verification?: {
    status: "match" | "partial" | "no-match";
    matched_ratio: number;
    method?: string;
    reason?: string;
  } | null;
  error?: string | null;
}

export interface AttachmentAnalysisReport {
  requested: boolean;
  status: "completed" | "partial" | "failed";
  recognition_status?: "recognized" | "partial" | "not-recognized";
  recognition_total?: number;
  recognized_count?: number;
  scored: false;
  affects_primary_score: false;
  completed: number;
  total: number;
  items: AttachmentAnalysisItem[];
}
