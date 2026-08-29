import { describe, expect, it } from "vitest";
import {
  isNoticeDismissed,
  MAX_DISMISSED_CORRELATED_NOTICE_KEYS,
  noticeDismissalKey,
  noticeExpiresAt,
  noticeIdentityMatches,
  rememberDismissedNoticeKey,
  type NoticeInput
} from "./NoticeCenter";

const baseNotice: NoticeInput = {
  id: "operation-1",
  severity: "info",
  title: "Операция",
  detail: "Проверяем состояние."
};

describe("NoticeCenter lifetime and identity contract", () => {
  it("matches only the same id or two equal non-empty correlation ids", () => {
    expect(noticeIdentityMatches(baseNotice, { ...baseNotice })).toBe(true);
    expect(noticeIdentityMatches(baseNotice, { ...baseNotice, id: "operation-2" })).toBe(false);
    expect(noticeIdentityMatches(
      { ...baseNotice, id: "operation-2", correlationId: "" },
      { ...baseNotice, id: "operation-3", correlationId: "" }
    )).toBe(false);
    expect(noticeIdentityMatches(
      { ...baseNotice, id: "operation-2", correlationId: "same-operation" },
      { ...baseNotice, id: "operation-3", correlationId: "same-operation" }
    )).toBe(true);
  });

  it("keeps progress and generic info persistent while applying semantic defaults", () => {
    const now = 1_000;
    expect(noticeExpiresAt({ ...baseNotice, severity: "info" }, now)).toBeUndefined();
    expect(noticeExpiresAt({ ...baseNotice, severity: "progress" }, now)).toBeUndefined();
    expect(noticeExpiresAt({ ...baseNotice, severity: "success" }, now)).toBe(7_000);
    expect(noticeExpiresAt({ ...baseNotice, severity: "warning" }, now)).toBe(11_000);
    expect(noticeExpiresAt({ ...baseNotice, severity: "error" }, now)).toBe(13_000);
  });

  it("gives explicit expiry and timeout precedence over severity defaults", () => {
    const now = 2_000;
    expect(noticeExpiresAt({ ...baseNotice, severity: "success", expiresAt: 9_000, timeoutMs: 1 }, now)).toBe(9_000);
    expect(noticeExpiresAt({ ...baseNotice, severity: "warning", timeoutMs: 1_500 }, now)).toBe(3_500);
  });

  it("keeps dismissal tied to a stable correlated event identity", () => {
    const progress = { ...baseNotice, id: "rog-g703.action.progress", correlationId: "wake-1" };
    const terminal = { ...baseNotice, id: "rog-g703.action.terminal", correlationId: "wake-1" };
    const secondAction = { ...terminal, correlationId: "wake-2" };
    const dismissed = new Set([noticeDismissalKey(progress)!]);

    expect(noticeDismissalKey(progress)).toBe("notice:rog-g703.action.progress:correlation:wake-1");
    expect(isNoticeDismissed(progress, dismissed)).toBe(true);
    expect(isNoticeDismissed(terminal, dismissed)).toBe(false);
    expect(isNoticeDismissed(secondAction, dismissed)).toBe(false);
    expect(isNoticeDismissed({ ...baseNotice, id: "rog-g703.action.progress" }, dismissed)).toBe(false);
    expect(noticeDismissalKey(baseNotice)).toBeUndefined();
    expect(isNoticeDismissed(baseNotice, dismissed)).toBe(false);
  });

  it("bounds correlated dismissal history with deterministic FIFO eviction", () => {
    const dismissed = new Set<string>();
    const first = { ...baseNotice, id: "rog-g703.action.progress", correlationId: "wake-0" };
    const recent = { ...baseNotice, id: "rog-g703.action.progress", correlationId: "wake-recent" };

    rememberDismissedNoticeKey(dismissed, noticeDismissalKey(first)!);
    for (let index = 1; index < MAX_DISMISSED_CORRELATED_NOTICE_KEYS; index += 1) {
      rememberDismissedNoticeKey(dismissed, `notice:synthetic:${index}`);
    }
    expect(dismissed).toHaveLength(MAX_DISMISSED_CORRELATED_NOTICE_KEYS);

    const orderBeforeDuplicate = [...dismissed];
    rememberDismissedNoticeKey(dismissed, noticeDismissalKey(first)!);
    expect([...dismissed]).toEqual(orderBeforeDuplicate);

    rememberDismissedNoticeKey(dismissed, noticeDismissalKey(recent)!);
    expect(dismissed).toHaveLength(MAX_DISMISSED_CORRELATED_NOTICE_KEYS);
    expect(dismissed.has(noticeDismissalKey(first)!)).toBe(false);
    expect(isNoticeDismissed(first, dismissed)).toBe(false);
    expect(isNoticeDismissed(recent, dismissed)).toBe(true);

    for (let index = 0; index < 5; index += 1) {
      rememberDismissedNoticeKey(dismissed, `notice:overflow:${index}`);
    }
    expect(dismissed).toHaveLength(MAX_DISMISSED_CORRELATED_NOTICE_KEYS);
    expect(isNoticeDismissed(recent, dismissed)).toBe(true);
    expect(dismissed.has("notice:synthetic:1")).toBe(false);
  });
});
