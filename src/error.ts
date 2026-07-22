export class FifaDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FifaDatabaseError";
  }
}

export function requireValue<T>(value: T | undefined, context: string): T {
  if (value === undefined) {
    throw new FifaDatabaseError(`Internal database invariant failed: ${context}`);
  }
  return value;
}
