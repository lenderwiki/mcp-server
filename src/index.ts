import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.LENDERWIKI_API_URL || "https://lenderwiki.com/api/v1";
const API_KEY = process.env.LENDERWIKI_API_KEY || "";

async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": "lenderwiki-mcp/1.0",
  };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  if (options?.body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function calcMonthlyPayment(principal: number, annualRate: number, months: number): number {
  if (annualRate === 0) return principal / months;
  const r = annualRate / 100 / 12;
  return (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
}

const server = new McpServer({
  name: "lenderwiki",
  version: "1.0.0",
});

server.tool(
  "find_lenders",
  "Search the LenderWiki database of 13,000+ US consumer lenders. Filter by state, lender type, credit score, ITIN acceptance, and more. Returns a list of matching lenders with key details.",
  {
    state: z.string().length(2).optional().describe("Two-letter US state code (e.g. 'CA', 'TX')"),
    lender_type: z.enum(["online", "bank", "credit_union", "cdfi", "nonprofit", "tribal", "fintech"]).optional().describe("Type of lending institution"),
    accepts_itin: z.boolean().optional().describe("Filter for lenders that accept ITIN"),
    credit_score: z.number().optional().describe("Applicant's credit score — filters to lenders accepting this score"),
    loan_amount: z.number().optional().describe("Desired loan amount in USD"),
    limit: z.number().min(1).max(50).optional().describe("Maximum results to return (default 20)"),
  },
  async (params) => {
    try {
      const queryParts: string[] = [];
      if (params.state) queryParts.push(`state=${params.state.toUpperCase()}`);
      if (params.lender_type) queryParts.push(`type=${params.lender_type}`);
      queryParts.push(`limit=${params.limit ?? 20}`);
      queryParts.push(`sort=confidence`);

      const qs = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
      const data = await api<any>(`/lenders${qs}`);
      const lenders: any[] = data.lenders ?? [];

      if (lenders.length === 0) {
        return { content: [{ type: "text" as const, text: "No lenders found matching your criteria. Try broadening your search." }] };
      }

      let filtered = lenders;

      if (params.accepts_itin) {
        filtered = filtered.filter(l => l.accepts_itin === true);
      }

      if (params.credit_score !== undefined) {
        filtered = filtered.filter(l => {
          if (l.min_credit_score === null || l.min_credit_score === undefined) return true;
          return l.min_credit_score <= params.credit_score!;
        });
      }

      if (params.loan_amount !== undefined) {
        filtered = filtered.filter(l => {
          if (!l.max_loan_amount) return true;
          return params.loan_amount! <= l.max_loan_amount;
        });
      }

      const results = filtered.map(l => {
        const lines: string[] = [
          `## ${l.display_name || l.legal_name}`,
          `**Type:** ${l.lender_type || "N/A"} | **State:** ${l.headquarters_state || "N/A"}`,
          `**Data Confidence:** ${l.data_confidence ?? 0}%`,
        ];
        if (l.editorial_verdict) lines.push(`**Verdict:** ${l.editorial_verdict}`);
        if (l.bbb_rating) lines.push(`**BBB Rating:** ${l.bbb_rating}`);
        if (l.google_rating) lines.push(`**Google Rating:** ${l.google_rating}/5 (${l.google_review_count ?? 0} reviews)`);
        if (l.cfpb_complaint_count_12mo) lines.push(`**CFPB Complaints (12mo):** ${l.cfpb_complaint_count_12mo}`);
        if (l.has_active_warnings) lines.push(`⚠️ Active regulatory action recorded`);
        if (l.accepts_itin) lines.push(`✅ Accepts ITIN`);
        if (l.website_url) lines.push(`**Website:** ${l.website_url}`);
        lines.push(`**LenderWiki:** https://lenderwiki.com/lenders/${l.slug}`);
        lines.push("");
        return lines.join("\n");
      });

      return {
        content: [{
          type: "text" as const,
          text: `Found ${filtered.length} lender(s):\n\n${results.join("\n---\n\n")}\n\n_Data from LenderWiki (lenderwiki.com). Last verified dates vary by lender._`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error searching lenders: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_lender_profile",
  "Get a comprehensive profile of a specific US consumer lender including products, APR ranges, fees, eligibility requirements, customer feedback, and regulatory status.",
  {
    slug: z.string().describe("The lender's slug (URL identifier), e.g. 'upstart', 'sofi', 'lending-club'"),
  },
  async (params) => {
    try {
      const data = await api<any>(`/lenders/${encodeURIComponent(params.slug)}`);

      const lender = data;
      const products: any[] = lender.products ?? [];
      const eligibility = lender.eligibility ?? null;
      const regActions: any[] = lender.regulatory_actions ?? [];

      const lines: string[] = [`# ${lender.display_name || lender.legal_name}`, ""];

      if (lender.company_description) {
        lines.push(`## About`);
        lines.push(lender.company_description);
        lines.push("");
      }

      lines.push(`## Key Facts`);
      lines.push(`- **Legal Name:** ${lender.legal_name}`);
      lines.push(`- **Type:** ${lender.lender_type}`);
      if (lender.nmls_id) lines.push(`- **NMLS ID:** ${lender.nmls_id}`);
      if (lender.parent_company) lines.push(`- **Parent Company:** ${lender.parent_company}`);
      if (lender.headquarters_city) lines.push(`- **Headquarters:** ${lender.headquarters_city}, ${lender.headquarters_state}`);
      if (lender.year_established) lines.push(`- **Established:** ${lender.year_established}`);
      lines.push(`- **Website:** ${lender.website_url || "N/A"}`);
      lines.push(`- **Data Confidence:** ${lender.data_confidence ?? 0}%`);
      if (lender.last_verified_at) lines.push(`- **Last Verified:** ${lender.last_verified_at}`);
      lines.push("");

      if (products.length > 0) {
        lines.push(`## What It Costs`);
        for (const p of products) {
          lines.push(`### ${p.product_name || p.product_type}`);
          if (p.min_amount || p.max_amount) {
            lines.push(`- **Amount Range:** $${p.min_amount?.toLocaleString() ?? "?"} – $${p.max_amount?.toLocaleString() ?? "?"}`);
          }
          if (p.apr_min || p.apr_max) {
            lines.push(`- **APR:** ${p.apr_min ?? "?"}% – ${p.apr_max ?? "?"}%`);
          }
          if (p.origination_fee_min || p.origination_fee_max) {
            lines.push(`- **Origination Fee:** ${p.origination_fee_min ?? 0}% – ${p.origination_fee_max ?? 0}%`);
          }
          if (p.term_min_months || p.term_max_months) {
            lines.push(`- **Term:** ${p.term_min_months ?? "?"} – ${p.term_max_months ?? "?"} months`);
          }
          if (p.funding_speed) lines.push(`- **Funding Speed:** ${p.funding_speed}`);

          if (p.apr_typical && p.max_amount && p.term_max_months) {
            const payment = calcMonthlyPayment(p.max_amount / 2, p.apr_typical, p.term_max_months);
            lines.push(`- **Est. Monthly Payment:** ~$${Math.round(payment)} (on $${(p.max_amount / 2).toLocaleString()} at ${p.apr_typical}% for ${p.term_max_months} mo)`);
          }
          lines.push("");
        }
      }

      if (eligibility) {
        lines.push(`## Who Can Apply`);
        if (eligibility.min_credit_score) lines.push(`- **Minimum Credit Score:** ${eligibility.min_credit_score}`);
        if (eligibility.credit_check_type) lines.push(`- **Credit Check:** ${eligibility.credit_check_type}`);
        if (eligibility.accepts_no_credit_history) lines.push(`- ✅ Accepts applicants with no credit history`);
        if (eligibility.min_annual_income) lines.push(`- **Minimum Annual Income:** $${Number(eligibility.min_annual_income).toLocaleString()}`);
        if (eligibility.income_verification) lines.push(`- **Income Verification:** ${eligibility.income_verification}`);
        if (eligibility.employment_types_accepted?.length) lines.push(`- **Employment Types:** ${eligibility.employment_types_accepted.join(", ")}`);
        if (eligibility.accepts_itin || lender.accepts_itin) lines.push(`- ✅ Accepts ITIN`);
        if (eligibility.requires_us_citizen) lines.push(`- Requires US citizenship`);
        if (eligibility.accepts_permanent_resident) lines.push(`- ✅ Accepts permanent residents`);
        if (eligibility.requires_bank_account) lines.push(`- Requires active bank account`);
        if (eligibility.max_dti_ratio) lines.push(`- **Max DTI Ratio:** ${eligibility.max_dti_ratio}%`);
        if (eligibility.bankruptcy_restriction) lines.push(`- **Bankruptcy:** ${eligibility.bankruptcy_restriction}`);
        if (eligibility.offers_prequalification) lines.push(`- ✅ Offers prequalification${eligibility.prequal_is_soft_pull ? " (soft pull — no impact on credit)" : ""}`);
        lines.push("");
      }

      lines.push(`## What Customers Say`);
      if (lender.google_rating) lines.push(`- **Google Rating:** ${lender.google_rating}/5 (${lender.google_review_count ?? 0} reviews)`);
      if (lender.bbb_rating) lines.push(`- **BBB Rating:** ${lender.bbb_rating}${lender.bbb_accredited ? " (Accredited)" : ""}`);
      if (lender.customers_praise?.length) lines.push(`- **Customers praise:** ${lender.customers_praise.join("; ")}`);
      if (lender.customers_warn?.length) lines.push(`- **Customers note:** ${lender.customers_warn.join("; ")}`);
      if (lender.editorial_verdict) lines.push(`- **Editorial Verdict:** ${lender.editorial_verdict}`);
      lines.push("");

      if (lender.cfpb_complaint_count_12mo) {
        lines.push(`## Customer Complaints`);
        lines.push(`- **CFPB Complaints (past 12 months):** ${lender.cfpb_complaint_count_12mo}`);
        if (lender.cfpb_resolution_rate) lines.push(`- **Resolution Rate:** ${lender.cfpb_resolution_rate}%`);
        if (lender.cfpb_trend) lines.push(`- **Trend:** ${lender.cfpb_trend}`);
        if (lender.cfpb_common_issues?.length) lines.push(`- **Common Issues:** ${lender.cfpb_common_issues.join(", ")}`);
        lines.push("");
      }

      if (lender.has_active_warnings || regActions.length > 0) {
        lines.push(`## Regulatory Status`);
        if (lender.has_active_warnings) lines.push(`⚠️ Active regulatory action recorded`);
        if (lender.warning_summary) lines.push(lender.warning_summary);
        for (const a of regActions) {
          lines.push(`- **${a.action_type}** by ${a.issuing_authority} (${a.date_issued})${a.fine_amount ? ` — $${Number(a.fine_amount).toLocaleString()} fine` : ""}${a.is_resolved ? " (Resolved)" : ""}`);
        }
        lines.push("");
      }

      lines.push(`---`);
      lines.push(`_Source: LenderWiki (https://lenderwiki.com/lenders/${lender.slug}). Data confidence: ${lender.data_confidence ?? 0}%._`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Lender "${params.slug}" not found. Use find_lenders to search for available lenders. (${err.message})` }] };
    }
  }
);

server.tool(
  "compare_lenders",
  "Compare two or more US consumer lenders side by side. Generates a comparison table of rates, fees, eligibility requirements, and customer feedback.",
  {
    slugs: z.array(z.string()).min(2).max(5).describe("Array of lender slugs to compare, e.g. ['upstart', 'lending-club']"),
  },
  async (params) => {
    try {
      const lenderResults = await Promise.allSettled(
        params.slugs.map(slug => api<any>(`/lenders/${encodeURIComponent(slug)}`))
      );

      const lenders: any[] = [];
      const notFound: string[] = [];

      for (let i = 0; i < params.slugs.length; i++) {
        const result = lenderResults[i];
        if (result.status === "fulfilled") {
          lenders.push(result.value);
        } else {
          notFound.push(params.slugs[i]);
        }
      }

      if (lenders.length === 0) {
        return { content: [{ type: "text" as const, text: "Could not find any of the specified lenders. Use find_lenders to search." }] };
      }

      const lines: string[] = [`# Lender Comparison\n`];

      for (const lender of lenders) {
        const products: any[] = lender.products ?? [];
        const eligibility = lender.eligibility ?? null;

        lines.push(`## ${lender.display_name || lender.legal_name}`);
        lines.push(`| Metric | Value |`);
        lines.push(`|--------|-------|`);
        lines.push(`| Type | ${lender.lender_type} |`);
        lines.push(`| Headquarters | ${lender.headquarters_city ? `${lender.headquarters_city}, ${lender.headquarters_state}` : lender.headquarters_state || "N/A"} |`);

        if (products.length > 0) {
          const aprMins = products.filter(p => p.apr_min != null).map(p => Number(p.apr_min));
          const aprMaxes = products.filter(p => p.apr_max != null).map(p => Number(p.apr_max));
          const amtMins = products.filter(p => p.min_amount != null).map(p => Number(p.min_amount));
          const amtMaxes = products.filter(p => p.max_amount != null).map(p => Number(p.max_amount));

          if (aprMins.length > 0) lines.push(`| APR Range | ${Math.min(...aprMins)}% – ${Math.max(...aprMaxes)}% |`);
          if (amtMins.length > 0) lines.push(`| Loan Amount | $${Math.min(...amtMins).toLocaleString()} – $${Math.max(...amtMaxes).toLocaleString()} |`);

          const terms = products.filter(p => p.term_max_months).map(p => p.term_max_months);
          if (terms.length > 0) lines.push(`| Max Term | ${Math.max(...terms)} months |`);

          const fees = products.filter(p => p.origination_fee_max).map(p => Number(p.origination_fee_max));
          if (fees.length > 0) lines.push(`| Origination Fee | Up to ${Math.max(...fees)}% |`);

          const speeds = products.filter(p => p.funding_speed).map(p => p.funding_speed);
          if (speeds.length > 0) lines.push(`| Funding Speed | ${speeds[0]} |`);
        }

        if (eligibility) {
          if (eligibility.min_credit_score) lines.push(`| Min Credit Score | ${eligibility.min_credit_score} |`);
          if (eligibility.credit_check_type) lines.push(`| Credit Check | ${eligibility.credit_check_type} |`);
          lines.push(`| Accepts ITIN | ${eligibility.accepts_itin || lender.accepts_itin ? "Yes" : "No"} |`);
          lines.push(`| Accepts No Credit | ${eligibility.accepts_no_credit_history ? "Yes" : "No"} |`);
          if (eligibility.offers_prequalification) lines.push(`| Prequalification | Yes${eligibility.prequal_is_soft_pull ? " (soft pull)" : ""} |`);
        }

        lines.push(`| BBB Rating | ${lender.bbb_rating || "N/A"} |`);
        lines.push(`| Google Rating | ${lender.google_rating ? `${lender.google_rating}/5` : "N/A"} |`);
        lines.push(`| CFPB Complaints (12mo) | ${lender.cfpb_complaint_count_12mo ?? 0} |`);
        lines.push(`| Warnings | ${lender.has_active_warnings ? "⚠️ Yes" : "None"} |`);
        lines.push(`| Data Confidence | ${lender.data_confidence ?? 0}% |`);
        lines.push(`| Profile | https://lenderwiki.com/lenders/${lender.slug} |`);
        lines.push("");
      }

      if (notFound.length > 0) {
        lines.push(`_Note: The following lender(s) were not found: ${notFound.join(", ")}_`);
      }

      lines.push(`---`);
      lines.push(`_Source: LenderWiki (lenderwiki.com). Data confidence varies by lender._`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error comparing lenders: ${err.message}` }] };
    }
  }
);

server.tool(
  "check_eligibility",
  "Check whether a person is likely eligible for a specific lender's products. Returns a detailed assessment with match reasons, caveats, and potential dealbreakers.",
  {
    slug: z.string().describe("The lender's slug"),
    credit_score: z.number().optional().describe("Applicant's credit score (300-850)"),
    annual_income: z.number().optional().describe("Applicant's annual gross income in USD"),
    state: z.string().length(2).optional().describe("Applicant's state of residence (two-letter code)"),
    employment_type: z.enum(["W2", "self_employed", "1099", "gig", "unemployed", "retired", "student"]).optional().describe("Applicant's employment type"),
    has_itin: z.boolean().optional().describe("Whether applicant uses an ITIN instead of SSN"),
    loan_amount: z.number().optional().describe("Desired loan amount in USD"),
    has_bank_account: z.boolean().optional().describe("Whether applicant has an active bank account"),
    has_bankruptcy: z.boolean().optional().describe("Whether applicant has a bankruptcy on record"),
  },
  async (params) => {
    try {
      const data = await api<any>(`/lenders/${encodeURIComponent(params.slug)}`);
      const lender = data;
      const products: any[] = lender.products ?? [];
      const eligibility = lender.eligibility ?? null;

      const matchReasons: string[] = [];
      const caveats: string[] = [];
      const dealbreakers: string[] = [];

      if (eligibility) {
        if (params.credit_score !== undefined && eligibility.min_credit_score) {
          if (params.credit_score >= eligibility.min_credit_score) {
            matchReasons.push(`Your credit score (${params.credit_score}) meets the minimum requirement (${eligibility.min_credit_score})`);
          } else {
            dealbreakers.push(`Your credit score (${params.credit_score}) is below the minimum requirement (${eligibility.min_credit_score})`);
          }
        }

        if (params.annual_income !== undefined && eligibility.min_annual_income) {
          if (params.annual_income >= Number(eligibility.min_annual_income)) {
            matchReasons.push(`Your income ($${params.annual_income.toLocaleString()}) meets the minimum ($${Number(eligibility.min_annual_income).toLocaleString()})`);
          } else {
            dealbreakers.push(`Your income ($${params.annual_income.toLocaleString()}) is below the minimum ($${Number(eligibility.min_annual_income).toLocaleString()})`);
          }
        }

        if (params.has_itin) {
          if (eligibility.accepts_itin || lender.accepts_itin) {
            matchReasons.push("This lender accepts ITIN applicants");
          } else {
            dealbreakers.push("This lender does not accept ITIN — an SSN may be required");
          }
        }

        if (params.employment_type && eligibility.employment_types_accepted?.length) {
          const accepted = eligibility.employment_types_accepted.map((t: string) => t.toLowerCase());
          if (accepted.includes(params.employment_type.toLowerCase()) || accepted.includes("all")) {
            matchReasons.push(`Your employment type (${params.employment_type}) is accepted`);
          } else {
            caveats.push(`Your employment type (${params.employment_type}) may not be accepted — verify with lender`);
          }
        }

        if (params.has_bank_account === false && eligibility.requires_bank_account) {
          dealbreakers.push("This lender requires an active bank account");
        }

        if (params.has_bankruptcy && eligibility.bankruptcy_restriction) {
          if (eligibility.bankruptcy_restriction === "none") {
            matchReasons.push("This lender has no bankruptcy restrictions");
          } else {
            caveats.push(`Bankruptcy restriction: ${eligibility.bankruptcy_restriction}`);
          }
        }

        if (eligibility.offers_prequalification) {
          matchReasons.push(`Offers prequalification${eligibility.prequal_is_soft_pull ? " with soft pull (no credit impact)" : ""}`);
        }
      } else {
        caveats.push("Limited eligibility data available — check directly with the lender");
      }

      if (params.state && products.length > 0) {
        const stateUpper = params.state.toUpperCase();
        const available = products.some(p => {
          if (p.states_excluded?.includes(stateUpper)) return false;
          if (!p.states_available || p.states_available.length === 0) return true;
          return p.states_available.includes(stateUpper);
        });
        if (available) {
          matchReasons.push(`Available in ${stateUpper}`);
        } else {
          dealbreakers.push(`May not be available in ${stateUpper}`);
        }
      }

      if (params.loan_amount && products.length > 0) {
        const inRange = products.some(p =>
          (!p.min_amount || params.loan_amount! >= Number(p.min_amount)) &&
          (!p.max_amount || params.loan_amount! <= Number(p.max_amount))
        );
        if (inRange) {
          matchReasons.push(`Your desired amount ($${params.loan_amount.toLocaleString()}) is within their lending range`);
        } else {
          caveats.push(`Your desired amount ($${params.loan_amount.toLocaleString()}) may be outside their typical range`);
        }
      }

      let overallAssessment: string;
      if (dealbreakers.length > 0) {
        overallAssessment = "❌ **Unlikely Match** — there are potential dealbreakers";
      } else if (matchReasons.length >= 3) {
        overallAssessment = "✅ **Likely Match** — your profile aligns well with this lender's requirements";
      } else if (matchReasons.length > 0) {
        overallAssessment = "🟡 **Possible Match** — some criteria match, but more information may be needed";
      } else {
        overallAssessment = "⚪ **Insufficient Data** — not enough information to assess eligibility";
      }

      const lines: string[] = [
        `# Eligibility Check: ${lender.display_name || lender.legal_name}`,
        "",
        `## Overall Assessment`,
        overallAssessment,
        "",
      ];

      if (matchReasons.length > 0) {
        lines.push(`## ✅ Match Reasons`);
        matchReasons.forEach(r => lines.push(`- ${r}`));
        lines.push("");
      }

      if (caveats.length > 0) {
        lines.push(`## 🟡 Caveats`);
        caveats.forEach(c => lines.push(`- ${c}`));
        lines.push("");
      }

      if (dealbreakers.length > 0) {
        lines.push(`## ❌ Potential Dealbreakers`);
        dealbreakers.forEach(d => lines.push(`- ${d}`));
        lines.push("");
      }

      lines.push(`---`);
      lines.push(`_This is a preliminary assessment based on available data. Always confirm eligibility directly with the lender._`);
      lines.push(`_Profile: https://lenderwiki.com/lenders/${lender.slug}_`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Lender "${params.slug}" not found. Use find_lenders to search. (${err.message})` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
