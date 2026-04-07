import { generateText } from "ai";
import type { LanguageModel } from "ai";

export interface ParsedDeal {
  company: string;
  founder: string;
  founderLinkedIn?: string;
  stage: string;
  roundSize: string;
  geo: string;
  sector: string;
  source: string;
  notes?: string;
  confidence: "high" | "medium" | "low";
}

export async function parseDealFromText(model: LanguageModel, rawText: string): Promise<ParsedDeal> {
  const { text: responseText } = await generateText({
    model,
    system: `You are a deal flow parser for a venture capital fund.
Extract structured deal information from the unstructured text below.
The text might be a forwarded WhatsApp message, an email snippet, a LinkedIn profile link, or just a casual mention.
Extract what you can. Mark anything you cannot determine as "Unknown".
Be precise with geography: if a LinkedIn URL shows a German city, set geo accordingly.
For stage, infer from round size if not explicitly stated (e.g. <1M is likely Pre-seed, 1-4M is Seed, 5-15M is Series A).

You MUST respond with ONLY a valid JSON object, no markdown, no code fences, no explanation. Just the JSON.

The JSON must have these fields:
{
  "company": "Company name or 'Stealth' if not mentioned",
  "founder": "Founder name(s)",
  "founderLinkedIn": "LinkedIn URL if mentioned, or null",
  "stage": "Pre-seed | Seed | Series A | Series B | Series C+ | Unknown",
  "roundSize": "Round size like '2M EUR' or 'Unknown'",
  "geo": "Geography like 'Berlin, Germany' or 'Unknown'",
  "sector": "Industry like 'B2B SaaS', 'FinTech', etc.",
  "source": "How it came in, like 'Cold inbound', 'Partner referral', or 'Unknown'",
  "notes": "Any additional context or null",
  "confidence": "high | medium | low"
}`,
    prompt: rawText,
  });

  try {
    const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      company: parsed.company || "Unknown",
      founder: parsed.founder || "Unknown",
      founderLinkedIn: parsed.founderLinkedIn || undefined,
      stage: parsed.stage || "Unknown",
      roundSize: parsed.roundSize || "Unknown",
      geo: parsed.geo || "Unknown",
      sector: parsed.sector || "Unknown",
      source: parsed.source || "Unknown",
      notes: parsed.notes || undefined,
      confidence: parsed.confidence || "medium",
    };
  } catch {
    return {
      company: "Unknown", founder: "Unknown", stage: "Unknown", roundSize: "Unknown",
      geo: "Unknown", sector: "Unknown", source: "Unknown",
      notes: `Could not parse: ${rawText.slice(0, 200)}`, confidence: "low",
    };
  }
}
