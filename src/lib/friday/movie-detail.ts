export function normalizeFridayMovieId(value: unknown): string | null {
  const normalized =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";

  return /^[a-zA-Z0-9_-]{1,30}$/.test(normalized) ? normalized : null;
}
