/**
 * 發送相關的小工具（平台無關、不依賴任何 adapter）：
 * - withSendTimeout：單次發送的逾時保護（底層 promise 偶爾不 settle，不能讓回覆卡死）。
 * - sanitizeReplyText：清掉控制字與 ANSI（聊天室顯示不了，還可能搞壞發送）。
 * 放在獨立模組，讓測試不必載入整個 adapter 依賴鏈。
 */

/** 比賽：本體先回就用本體的，逾時先到就丟錯（本體之後才回也無害，不算 unhandled rejection）。 */
export function withSendTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  // 掛一個已處理的分支，避免本體晚到時變成 unhandled rejection 噪音。
  task.catch(() => {});
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

/** 回覆消毒：清控制字（保留 \t\n\r）與 ANSI 轉義；這些在聊天室顯示不了，還可能搞壞發送。 */
export function sanitizeReplyText(text: string): string {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
