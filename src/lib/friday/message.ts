import type { MessageLike, MovieData, MovieItem } from "@/components/friday/FridayPanel";

const MAX_MOVIE_CARDS = 60;

export function getPartText(message: MessageLike): string {
  if (!Array.isArray(message.parts)) return "";
  return message.parts.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("");
}

export function getMovieDataForMessage(message: MessageLike): MovieData[] {
  if (!Array.isArray(message.parts)) return [];
  const output: MovieData[] = [];
  const seen = new Set<string>();
  for (const part of message.parts) {
    if (part?.type !== "data-movies") continue;
    const data = part.data as MovieData | undefined;
    if (!data || typeof data.searchId !== "string" || !Array.isArray(data.results) || seen.has(data.searchId)) continue;
    seen.add(data.searchId);
    output.push({ ...data, results: data.results.filter((item): item is MovieItem => Boolean(item) && typeof item === "object").slice(0, MAX_MOVIE_CARDS) });
  }
  return output;
}
