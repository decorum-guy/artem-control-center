export type CreateAttemptHandle = {
  key: string;
  bodyIdentity: string;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
      const normalized = canonicalize((value as Record<string, unknown>)[key]);
      return normalized === undefined ? [] : [[key, normalized]];
    })) as { [key: string]: JsonValue };
  }
  return undefined;
}

export function canonicalCreateBodyIdentity(body: unknown, targetBeanId?: string): string {
  const logicalBody = targetBeanId === undefined ? body : { beanId: targetBeanId, payload: body };
  return JSON.stringify(canonicalize(logicalBody)) ?? "null";
}

export type CoffeeDiaryCreateAttempt = ReturnType<typeof createCoffeeDiaryCreateAttempt>;

export function createCoffeeDiaryCreateAttempt(keyFactory: () => string = () => crypto.randomUUID()) {
  let attempt: CreateAttemptHandle | null = null;
  let pending = false;

  return {
    begin(body: unknown, targetBeanId?: string): CreateAttemptHandle | null {
      if (pending) return null;
      const bodyIdentity = canonicalCreateBodyIdentity(body, targetBeanId);
      if (!attempt || attempt.bodyIdentity !== bodyIdentity) attempt = { key: keyFactory(), bodyIdentity };
      pending = true;
      return { ...attempt };
    },
    release(): void {
      pending = false;
    },
    complete(): void {
      pending = false;
      attempt = null;
    },
    isPending(): boolean {
      return pending;
    },
    current(): CreateAttemptHandle | null {
      return attempt ? { ...attempt } : null;
    }
  };
}
