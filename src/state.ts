import type { LoginStatus, StatusState } from "./types.js";

const state: StatusState = {
  status: "未登入",
  startedAt: new Date().toISOString(),
};

export function getState(): StatusState {
  return { ...state };
}

export function setState(patch: Partial<StatusState>): void {
  Object.assign(state, patch);
}

export function setStatus(status: LoginStatus, patch: Partial<StatusState> = {}): void {
  Object.assign(state, { status, ...patch });
}
