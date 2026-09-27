export type LoginStatus =
  | "未登入"
  | "登入中"
  | "待驗證"
  | "已登入"
  | "已過期"
  | "需人工";

export interface StatusState {
  status: LoginStatus;
  startedAt: string;
  qrUrl?: string;
  pin?: string;
  profileName?: string;
  myMid?: string;
  friendCount?: number;
  chatCount?: number;
  lastLoginAt?: string;
  lastSendAt?: string;
  lastSendTo?: string;
  lastError?: string;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  time: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}
