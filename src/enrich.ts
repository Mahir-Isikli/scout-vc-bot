/** Enrichment via Exa web search - instant, deep, and live crawl modes */

import Exa from "exa-js";

export interface SearchResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
}

type SearchMode = "instant" | "deep" | "deep-reasoning";

function makeExa(apiKey: string) { return new Exa(apiKey); }

async function instantSearch(exa: Exa, query: string, opts?: { numResults?: number; category?: string; livecrawl?: boolean }): Promise<SearchResult[]> {
  try {
    const results = await exa.searchAndContents(query, {
      numResults: opts?.numResults ?? 5, type: "auto", text: { maxCharacters: 2000 },
      ...(opts?.category && { category: opts.category as any }),
      ...(opts?.livecrawl && { livecrawl: "always" as any }),
    });
    return results.results.map((r: any) => ({ title: r.title || "", url: r.url, text: (r.text || "").slice(0, 2000), publishedDate: r.publishedDate }));
  } catch (err) { console.error("Exa instant search failed:", err); return []; }
}

async function deepSearch(exa: Exa, query: string, opts?: { numResults?: number; category?: string }): Promise<SearchResult[]> {
  try {
    const results = await exa.searchAndContents(query, {
      numResults: opts?.numResults ?? 5, type: "deep" as any, text: { maxCharacters: 3000 },
      ...(opts?.category && { category: opts.category as any }),
    });
    return results.results.map((r: any) => ({ title: r.title || "", url: r.url, text: (r.text || "").slice(0, 3000), publishedDate: r.publishedDate }));
  } catch (err) { console.error("Exa deep search failed:", err); return []; }
}

export function searchCompany(exa: Exa, name: string, mode: SearchMode = "instant") {
  const fn = mode === "deep" ? deepSearch : instantSearch;
  return fn(exa, `${name} startup company funding round`, { numResults: 5, ...(mode === "instant" && { category: "company", livecrawl: true }) });
}

export function searchFounder(exa: Exa, name: string, company?: string, mode: SearchMode = "instant") {
  const q = company ? `${name} ${company} founder CEO background` : `${name} founder startup entrepreneur`;
  const fn = mode === "deep" ? deepSearch : instantSearch;
  return fn(exa, q, { numResults: 5 });
}

export function searchCompetitors(exa: Exa, name: string, sector: string, mode: SearchMode = "instant") {
  const fn = mode === "deep" ? deepSearch : instantSearch;
  return fn(exa, `${name} competitors alternatives ${sector} startup landscape`, { numResults: 5 });
}

export function searchFundingNews(exa: Exa, target: string) {
  return instantSearch(exa, `${target} funding round investment announcement 2026`, { numResults: 5, category: "news", livecrawl: true });
}

export function searchMarket(exa: Exa, sector: string, geo?: string) {
  return deepSearch(exa, `${sector}${geo ? ` ${geo}` : " Europe"} market size trends 2025 2026`, { numResults: 5, category: "research paper" });
}

export async function enrichDeal(exa: Exa, companyName: string, founderName?: string, sector?: string) {
  const [companyResults, founderResults, competitorResults, fundingNews] = await Promise.all([
    searchCompany(exa, companyName, "instant"),
    founderName ? searchFounder(exa, founderName, companyName, "instant") : Promise.resolve([]),
    sector ? searchCompetitors(exa, companyName, sector, "instant") : Promise.resolve([]),
    searchFundingNews(exa, companyName),
  ]);
  return { companyResults, founderResults, competitorResults, fundingNews };
}

export async function deepEnrichDeal(exa: Exa, companyName: string, founderName?: string, sector?: string) {
  const [companyResults, founderResults, competitorResults, marketResults] = await Promise.all([
    searchCompany(exa, companyName, "deep"),
    founderName ? searchFounder(exa, founderName, companyName, "deep") : Promise.resolve([]),
    sector ? searchCompetitors(exa, companyName, sector, "deep") : Promise.resolve([]),
    sector ? searchMarket(exa, sector) : Promise.resolve([]),
  ]);
  return { companyResults, founderResults, competitorResults, marketResults };
}

export { makeExa };
