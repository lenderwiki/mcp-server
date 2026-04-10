import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set");
}

const supabase = createClient(supabaseUrl, supabaseKey);

const PUBLIC_STATUSES = ["public_unverified", "public_verified", "citable", "disputed", "archived"];

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
  "Search the LenderWiki database of 13,000+ US consumer lenders. Filter by state availability, lender type, credit score, ITIN acceptance, cosigner, loan amount, product type, and APR.",
  {
    state: z.string().length(2).optional().describe("Two-letter US state code (e.g. 'CA', 'TX') — filters to lenders available in that state"),
    lender_type: z.enum(["online", "bank", "credit_union", "cdfi", "nonprofit", "tribal", "fintech", "consumer_finance", "traditional"]).optional().describe("Type of lending institution"),
    accepts_itin: z.boolean().optional().describe("Filter for lenders that accept ITIN"),
    cosigner: z.boolean().optional().describe("Filter for lenders that accept cosigners"),
    max_apr: z.number().optional().describe("Maximum APR to filter by"),
    min_amount: z.number().optional().describe("Minimum loan amount the borrower needs — filters to lenders that offer at least this amount"),
    max_amount: z.number().optional().describe("Maximum loan amount — filters to lenders with a minimum at or below this"),
    credit_score: z.number().optional().describe("Applicant's credit score — filters to lenders that accept this score"),
    product_type: z.string().optional().describe("Product type (e.g. 'personal_loan', 'credit_builder', 'line_of_credit', 'debt_consolidation')"),
    credit_check: z.enum(["none", "soft", "hard"]).optional().describe("Filter by credit check type — 'none' returns lenders with no hard pull"),
    limit: z.number().min(1).max(50).optional().describe("Maximum results to return (default 10)"),
  },
  async (params) => {
    const requestedLimit = params.limit ?? 10;

    let query = supabase
      .from("lenders")
      .select("id, slug, legal_name, display_name, lender_type, publication_status, data_confidence, headquarters_state, website_url, affiliate_url, cfpb_complaint_count_12mo, bbb_rating, google_rating, google_review_count, has_active_warnings, accepts_itin, is_active, last_verified_at, editorial_verdict, customers_praise, customers_warn")
      .in("publication_status", ["public_verified", "public_unverified", "citable"])
      .eq("is_active", true)
      .neq("lender_type", "non_consumer")
      .order("data_confidence", { ascending: false })
      .limit(200);

    if (params.lender_type) {
      query = query.eq("lender_type", params.lender_type);
    }

    const { data: lenders, error } = await query;

    if (error) {
      return { content: [{ type: "text" as const, text: `Error searching lenders: ${error.message}` }] };
    }

    if (!lenders || lenders.length === 0) {
      return { content: [{ type: "text" as const, text: "No lenders found matching your criteria." }] };
    }

    let filtered = lenders;
    const lenderIds = filtered.map(l => l.id);

    const needsProducts = params.state !== undefined || params.min_amount !== undefined || params.max_amount !== undefined || params.max_apr !== undefined || params.product_type !== undefined || params.cosigner !== undefined;
    const needsEligibility = params.credit_score !== undefined || params.credit_check !== undefined || params.accepts_itin !== undefined || params.cosigner !== undefined;

    const [prodRes, eligRes] = await Promise.all([
      needsProducts
        ? supabase.from("lender_products").select("lender_id, min_amount, max_amount, apr_max, product_type, states_available, states_excluded, cosigner_allowed").in("lender_id", lenderIds)
        : Promise.resolve({ data: null }),
      needsEligibility
        ? supabase.from("product_eligibility").select("lender_id, min_credit_score, credit_check_type, accepts_itin, cosigner_allowed").in("lender_id", lenderIds)
        : Promise.resolve({ data: null }),
    ]);

    const productsByLender = new Map<string, any[]>();
    if (prodRes.data) {
      for (const p of prodRes.data) {
        const arr = productsByLender.get(p.lender_id) ?? [];
        arr.push(p);
        productsByLender.set(p.lender_id, arr);
      }
    }

    const eligByLender = new Map<string, any[]>();
    if (eligRes.data) {
      for (const e of eligRes.data) {
        const arr = eligByLender.get(e.lender_id) ?? [];
        arr.push(e);
        eligByLender.set(e.lender_id, arr);
      }
    }

    if (params.state) {
      const st = params.state.toUpperCase();
      filtered = filtered.filter(l => {
        const prods = productsByLender.get(l.id);
        if (prods) {
          const hasAvail = prods.some(p => p.states_available?.includes(st));
          if (hasAvail) return true;
          const isExcluded = prods.some(p => p.states_excluded?.includes(st));
          if (isExcluded) return false;
        }
        return l.headquarters_state === st;
      });
    }

    if (params.accepts_itin) {
      filtered = filtered.filter(l => {
        if (l.accepts_itin) return true;
        const eligs = eligByLender.get(l.id);
        return eligs?.some(e => e.accepts_itin) ?? false;
      });
    }

    if (params.cosigner) {
      filtered = filtered.filter(l => {
        const eligs = eligByLender.get(l.id);
        const prods = productsByLender.get(l.id);
        return (eligs?.some(e => e.cosigner_allowed) ?? false) || (prods?.some(p => p.cosigner_allowed) ?? false);
      });
    }

    if (params.credit_score !== undefined) {
      filtered = filtered.filter(l => {
        const eligs = eligByLender.get(l.id);
        if (!eligs || eligs.length === 0) return false;
        return eligs.some(e => e.min_credit_score != null && e.min_credit_score <= params.credit_score!);
      });
    }

    if (params.credit_check) {
      filtered = filtered.filter(l => {
        const eligs = eligByLender.get(l.id);
        if (!eligs || eligs.length === 0) return false;
        if (params.credit_check === "none") {
          return eligs.some(e => e.credit_check_type === "none" || e.credit_check_type === "soft");
        }
        return eligs.some(e => e.credit_check_type === params.credit_check);
      });
    }

    if (params.product_type) {
      filtered = filtered.filter(l => {
        const prods = productsByLender.get(l.id);
        return prods?.some(p => p.product_type === params.product_type) ?? false;
      });
    }

    if (params.min_amount !== undefined) {
      filtered = filtered.filter(l => {
        const prods = productsByLender.get(l.id);
        return prods?.some(p => p.max_amount && Number(p.max_amount) >= params.min_amount!) ?? false;
      });
    }

    if (params.max_amount !== undefined) {
      filtered = filtered.filter(l => {
        const prods = productsByLender.get(l.id);
        return prods?.some(p => p.min_amount && Number(p.min_amount) <= params.max_amount!) ?? false;
      });
    }

    if (params.max_apr !== undefined) {
      filtered = filtered.filter(l => {
        const prods = productsByLender.get(l.id);
        return prods?.some(p => p.apr_max && Number(p.apr_max) <= params.max_apr!) ?? false;
      });
    }

    filtered = filtered.slice(0, requestedLimit);

    const results = filtered.map((l: any) => {
      const lines: string[] = [
        `## ${l.display_name}`,
        `**Type:** ${l.lender_type} | **HQ:** ${l.headquarters_state || "N/A"}`,
        `**Data Confidence:** ${l.data_confidence ?? 0}%`,
      ];
      if (l.editorial_verdict) lines.push(`**Verdict:** ${l.editorial_verdict}`);
      if (l.bbb_rating) lines.push(`**BBB Rating:** ${l.bbb_rating}`);
      if (l.google_rating) lines.push(`**Google Rating:** ${l.google_rating}/5 (${l.google_review_count ?? 0} reviews)`);
      if (l.cfpb_complaint_count_12mo) lines.push(`**CFPB Complaints (12mo):** ${l.cfpb_complaint_count_12mo}`);
      if (l.has_active_warnings) lines.push(`⚠️ Active regulatory action recorded`);
      if (l.accepts_itin) lines.push(`✅ Accepts ITIN`);
      if (l.customers_praise?.length) lines.push(`**Customers praise:** ${l.customers_praise.slice(0, 3).join("; ")}`);
      if (l.customers_warn?.length) lines.push(`**Customers note:** ${l.customers_warn.slice(0, 2).join("; ")}`);
      lines.push(`**Website:** ${l.website_url || "N/A"}`);
      lines.push(`**LenderWiki:** https://lenderwiki.com/lenders/${l.slug}`);
      lines.push("");
      return lines.join("\n");
    });

    return {
      content: [{
        type: "text" as const,
        text: `Found ${filtered.length} lender(s):\n\n${results.join("\n---\n\n")}\n\n_Data from LenderWiki._`,
      }],
    };
  }
);

server.tool(
  "get_lender_profile",
  "Get a detailed profile of a specific lender including products, eligibility requirements, fees, customer feedback, and regulatory status.",
  {
    slug: z.string().describe("The lender's slug (URL identifier), e.g. 'upstart', 'oportun', 'lending-club'"),
  },
  async (params) => {
    const { data: lender, error } = await supabase
      .from("lenders")
      .select("*")
      .eq("slug", params.slug)
      .in("publication_status", PUBLIC_STATUSES)
      .single();

    if (error || !lender) {
      return { content: [{ type: "text" as const, text: `Lender "${params.slug}" not found. Use find_lenders to search for available lenders.` }] };
    }

    const [productsRes, eligRes, regRes] = await Promise.all([
      supabase.from("lender_products").select("*").eq("lender_id", lender.id),
      supabase.from("product_eligibility").select("*").eq("lender_id", lender.id),
      supabase.from("regulatory_actions").select("*").eq("lender_id", lender.id).eq("human_approved", true),
    ]);

    const products = productsRes.data ?? [];
    const eligibility = eligRes.data ?? [];
    const regActions = regRes.data ?? [];

    const lenderElig = eligibility.find(e => !e.product_id) ?? eligibility[0] ?? null;

    const lines: string[] = [
      `# ${lender.display_name}`,
      '',
    ];

    if (lender.company_description) {
      lines.push(`## About ${lender.display_name}`);
      lines.push(lender.company_description);
      lines.push('');
    }

    lines.push(`## Key Facts`);
    lines.push(`- **Legal Name:** ${lender.legal_name}`);
    lines.push(`- **Type:** ${lender.lender_type}`);
    if (lender.nmls_id) lines.push(`- **NMLS ID:** ${lender.nmls_id}`);
    if (lender.parent_company) lines.push(`- **Parent Company:** ${lender.parent_company}`);
    if (lender.headquarters_city) lines.push(`- **Headquarters:** ${lender.headquarters_city}, ${lender.headquarters_state}`);
    if (lender.year_established) lines.push(`- **Established:** ${lender.year_established}`);
    lines.push(`- **Website:** ${lender.website_url || 'N/A'}`);
    lines.push(`- **Data Confidence:** ${lender.data_confidence ?? 0}%`);
    if (lender.last_verified_at) lines.push(`- **Last Verified:** ${lender.last_verified_at}`);
    lines.push('');

    if (products.length > 0) {
      lines.push(`## What It Costs`);
      for (const p of products) {
        lines.push(`### ${p.product_name || p.product_type}`);
        if (p.min_amount || p.max_amount) {
          lines.push(`- **Amount Range:** $${p.min_amount?.toLocaleString() ?? '?'} – $${p.max_amount?.toLocaleString() ?? '?'}`);
        }
        if (p.apr_min || p.apr_max) {
          lines.push(`- **APR:** ${p.apr_min ?? '?'}% – ${p.apr_max ?? '?'}%`);
        }
        if (p.origination_fee_min || p.origination_fee_max) {
          lines.push(`- **Origination Fee:** ${p.origination_fee_min ?? 0}% – ${p.origination_fee_max ?? 0}%`);
        }
        if (p.term_min_months || p.term_max_months) {
          lines.push(`- **Term:** ${p.term_min_months ?? '?'} – ${p.term_max_months ?? '?'} months`);
        }
        if (p.funding_speed) lines.push(`- **Funding Speed:** ${p.funding_speed}`);
        if (p.repayment_type) lines.push(`- **Repayment:** ${p.repayment_type}`);

        if (p.apr_typical && p.max_amount && p.term_max_months) {
          const payment = calcMonthlyPayment(p.max_amount / 2, p.apr_typical, p.term_max_months);
          lines.push(`- **Est. Monthly Payment:** ~$${Math.round(payment)} (on $${(p.max_amount / 2).toLocaleString()} at ${p.apr_typical}% for ${p.term_max_months} mo)`);
        }

        lines.push('');
      }
    }

    if (lenderElig) {
      lines.push(`## Who Can Apply`);
      if (lenderElig.min_credit_score) lines.push(`- **Minimum Credit Score:** ${lenderElig.min_credit_score}`);
      if (lenderElig.credit_check_type) lines.push(`- **Credit Check:** ${lenderElig.credit_check_type}`);
      if (lenderElig.accepts_no_credit_history) lines.push(`- ✅ Accepts applicants with no credit history`);
      if (lenderElig.min_annual_income) lines.push(`- **Minimum Annual Income:** $${Number(lenderElig.min_annual_income).toLocaleString()}`);
      if (lenderElig.income_verification) lines.push(`- **Income Verification:** ${lenderElig.income_verification}`);
      if (lenderElig.employment_types_accepted?.length) lines.push(`- **Employment Types:** ${lenderElig.employment_types_accepted.join(', ')}`);
      if (lenderElig.accepts_itin) lines.push(`- ✅ Accepts ITIN`);
      if (lenderElig.requires_us_citizen) lines.push(`- Requires US citizenship`);
      if (lenderElig.accepts_permanent_resident) lines.push(`- ✅ Accepts permanent residents`);
      if (lenderElig.requires_bank_account) lines.push(`- Requires active bank account`);
      if (lenderElig.max_dti_ratio) lines.push(`- **Max DTI Ratio:** ${lenderElig.max_dti_ratio}%`);
      if (lenderElig.bankruptcy_restriction) lines.push(`- **Bankruptcy:** ${lenderElig.bankruptcy_restriction}`);
      if (lenderElig.offers_prequalification) lines.push(`- ✅ Offers prequalification${lenderElig.prequal_is_soft_pull ? ' (soft pull — no impact on credit)' : ''}`);
      lines.push('');
    }

    lines.push(`## What Customers Say`);
    if (lender.google_rating) lines.push(`- **Google Rating:** ${lender.google_rating}/5 (${lender.google_review_count ?? 0} reviews)`);
    if (lender.bbb_rating) lines.push(`- **BBB Rating:** ${lender.bbb_rating}${lender.bbb_accredited ? ' (Accredited)' : ''}`);
    if (lender.customers_praise?.length) {
      lines.push(`- **Customers praise:** ${lender.customers_praise.join('; ')}`);
    }
    if (lender.customers_warn?.length) {
      lines.push(`- **Customers note:** ${lender.customers_warn.join('; ')}`);
    }
    if (lender.editorial_verdict) lines.push(`- **Editorial Verdict:** ${lender.editorial_verdict}`);
    lines.push('');

    if (lender.cfpb_complaint_count_12mo) {
      lines.push(`## Customer Complaints`);
      lines.push(`- **CFPB Complaints (past 12 months):** ${lender.cfpb_complaint_count_12mo}`);
      if (lender.cfpb_resolution_rate) lines.push(`- **Resolution Rate:** ${lender.cfpb_resolution_rate}%`);
      if (lender.cfpb_trend) lines.push(`- **Trend:** ${lender.cfpb_trend}`);
      if (lender.cfpb_common_issues?.length) lines.push(`- **Common Issues:** ${lender.cfpb_common_issues.join(', ')}`);
      lines.push('');
    }

    if (lender.has_active_warnings || regActions.length > 0) {
      lines.push(`## Regulatory Status`);
      if (lender.has_active_warnings) lines.push(`⚠️ Active regulatory action recorded`);
      if (lender.warning_summary) lines.push(lender.warning_summary);
      for (const a of regActions) {
        lines.push(`- **${a.action_type}** by ${a.issuing_authority} (${a.date_issued})${a.fine_amount ? ` — $${Number(a.fine_amount).toLocaleString()} fine` : ''}${a.is_resolved ? ' (Resolved)' : ''}`);
      }
      lines.push('');
    }

    lines.push(`---`);
    lines.push(`_Source: LenderWiki (lenderwiki.com/lenders/${lender.slug}). Data confidence: ${lender.data_confidence ?? 0}%._`);

    return {
      content: [{
        type: "text" as const,
        text: lines.join('\n'),
      }],
    };
  }
);

server.tool(
  "compare_lenders",
  "Compare two or more lenders side by side. Provides a comparison table of key metrics.",
  {
    slugs: z.array(z.string()).min(2).max(5).describe("Array of lender slugs to compare"),
  },
  async (params) => {
    const { data: lenders, error } = await supabase
      .from("lenders")
      .select("*")
      .in("slug", params.slugs)
      .in("publication_status", PUBLIC_STATUSES);

    if (error || !lenders || lenders.length === 0) {
      return { content: [{ type: "text" as const, text: "Could not find the specified lenders. Use find_lenders to search." }] };
    }

    const lenderIds = lenders.map(l => l.id);

    const [productsRes, eligRes] = await Promise.all([
      supabase.from("lender_products").select("*").in("lender_id", lenderIds),
      supabase.from("product_eligibility").select("*").in("lender_id", lenderIds),
    ]);

    const products = productsRes.data ?? [];
    const eligibility = eligRes.data ?? [];

    const productsByLender = new Map<string, typeof products>();
    for (const p of products) {
      const arr = productsByLender.get(p.lender_id) ?? [];
      arr.push(p);
      productsByLender.set(p.lender_id, arr);
    }

    const eligByLender = new Map<string, (typeof eligibility)[0]>();
    for (const e of eligibility) {
      if (!eligByLender.has(e.lender_id)) {
        eligByLender.set(e.lender_id, e);
      }
    }

    const lines: string[] = [`# Lender Comparison\n`];

    for (const lender of lenders) {
      const lp = productsByLender.get(lender.id) ?? [];
      const le = eligByLender.get(lender.id);

      lines.push(`## ${lender.display_name}`);
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Type | ${lender.lender_type} |`);
      lines.push(`| Headquarters | ${lender.headquarters_city ? `${lender.headquarters_city}, ${lender.headquarters_state}` : lender.headquarters_state || 'N/A'} |`);

      if (lp.length > 0) {
        const aprMin = Math.min(...lp.filter(p => p.apr_min).map(p => Number(p.apr_min)));
        const aprMax = Math.max(...lp.filter(p => p.apr_max).map(p => Number(p.apr_max)));
        const amtMin = Math.min(...lp.filter(p => p.min_amount).map(p => Number(p.min_amount)));
        const amtMax = Math.max(...lp.filter(p => p.max_amount).map(p => Number(p.max_amount)));

        if (isFinite(aprMin)) lines.push(`| APR Range | ${aprMin}% – ${aprMax}% |`);
        if (isFinite(amtMin)) lines.push(`| Loan Amount | $${amtMin.toLocaleString()} – $${amtMax.toLocaleString()} |`);

        const terms = lp.filter(p => p.term_max_months).map(p => p.term_max_months!);
        if (terms.length > 0) lines.push(`| Max Term | ${Math.max(...terms)} months |`);

        const fees = lp.filter(p => p.origination_fee_max).map(p => Number(p.origination_fee_max));
        if (fees.length > 0) lines.push(`| Origination Fee | Up to ${Math.max(...fees)}% |`);

        const speeds = lp.filter(p => p.funding_speed).map(p => p.funding_speed);
        if (speeds.length > 0) lines.push(`| Funding Speed | ${speeds[0]} |`);
      }

      if (le) {
        if (le.min_credit_score) lines.push(`| Min Credit Score | ${le.min_credit_score} |`);
        if (le.credit_check_type) lines.push(`| Credit Check | ${le.credit_check_type} |`);
        lines.push(`| Accepts ITIN | ${le.accepts_itin ? 'Yes' : 'No'} |`);
        lines.push(`| Accepts No Credit | ${le.accepts_no_credit_history ? 'Yes' : 'No'} |`);
        if (le.offers_prequalification) lines.push(`| Prequalification | Yes${le.prequal_is_soft_pull ? ' (soft pull)' : ''} |`);
      }

      lines.push(`| BBB Rating | ${lender.bbb_rating || 'N/A'} |`);
      lines.push(`| Google Rating | ${lender.google_rating ? `${lender.google_rating}/5` : 'N/A'} |`);
      lines.push(`| CFPB Complaints (12mo) | ${lender.cfpb_complaint_count_12mo ?? 0} |`);
      lines.push(`| Warnings | ${lender.has_active_warnings ? '⚠️ Yes' : 'None'} |`);
      lines.push(`| Data Confidence | ${lender.data_confidence ?? 0}% |`);
      lines.push('');
    }

    const notFound = params.slugs.filter(s => !lenders.find(l => l.slug === s));
    if (notFound.length > 0) {
      lines.push(`_Note: The following lender(s) were not found: ${notFound.join(', ')}_`);
    }

    lines.push(`---`);
    lines.push(`_Source: LenderWiki. Data confidence varies by lender._`);

    return {
      content: [{
        type: "text" as const,
        text: lines.join('\n'),
      }],
    };
  }
);

server.tool(
  "check_eligibility",
  "Check whether a person is likely eligible for a specific lender's products based on their financial profile.",
  {
    slug: z.string().describe("The lender's slug"),
    credit_score: z.number().optional().describe("Applicant's credit score (300-850)"),
    annual_income: z.number().optional().describe("Applicant's annual gross income in USD"),
    state: z.string().length(2).optional().describe("Applicant's state of residence"),
    employment_type: z.enum(["W2", "self_employed", "1099", "gig", "unemployed", "retired", "student"]).optional(),
    has_itin: z.boolean().optional().describe("Whether applicant uses an ITIN"),
    loan_amount: z.number().optional().describe("Desired loan amount in USD"),
    has_bank_account: z.boolean().optional().describe("Whether applicant has a bank account"),
    has_bankruptcy: z.boolean().optional().describe("Whether applicant has a bankruptcy on record"),
  },
  async (params) => {
    const { data: lender, error } = await supabase
      .from("lenders")
      .select("*")
      .eq("slug", params.slug)
      .in("publication_status", PUBLIC_STATUSES)
      .single();

    if (error || !lender) {
      return { content: [{ type: "text" as const, text: `Lender "${params.slug}" not found.` }] };
    }

    const [productsRes, eligRes] = await Promise.all([
      supabase.from("lender_products").select("*").eq("lender_id", lender.id),
      supabase.from("product_eligibility").select("*").eq("lender_id", lender.id),
    ]);

    const products = productsRes.data ?? [];
    const eligibility = eligRes.data ?? [];
    const elig = eligibility.find(e => !e.product_id) ?? eligibility[0] ?? null;

    const matchReasons: string[] = [];
    const caveats: string[] = [];
    const dealbreakers: string[] = [];

    if (elig) {
      if (params.credit_score !== undefined && elig.min_credit_score) {
        if (params.credit_score >= elig.min_credit_score) {
          matchReasons.push(`Your credit score (${params.credit_score}) meets the minimum requirement (${elig.min_credit_score})`);
        } else {
          dealbreakers.push(`Your credit score (${params.credit_score}) is below the minimum requirement (${elig.min_credit_score})`);
        }
      }

      if (params.annual_income !== undefined && elig.min_annual_income) {
        if (params.annual_income >= Number(elig.min_annual_income)) {
          matchReasons.push(`Your income ($${params.annual_income.toLocaleString()}) meets the minimum ($${Number(elig.min_annual_income).toLocaleString()})`);
        } else {
          dealbreakers.push(`Your income ($${params.annual_income.toLocaleString()}) is below the minimum ($${Number(elig.min_annual_income).toLocaleString()})`);
        }
      }

      if (params.has_itin) {
        if (elig.accepts_itin || lender.accepts_itin) {
          matchReasons.push("This lender accepts ITIN applicants");
        } else {
          dealbreakers.push("This lender does not accept ITIN — an SSN may be required");
        }
      }

      if (params.employment_type && elig.employment_types_accepted?.length) {
        const accepted = elig.employment_types_accepted.map((t: string) => t.toLowerCase());
        if (accepted.includes(params.employment_type.toLowerCase()) || accepted.includes("all")) {
          matchReasons.push(`Your employment type (${params.employment_type}) is accepted`);
        } else {
          caveats.push(`Your employment type (${params.employment_type}) may not be accepted — verify with lender`);
        }
      }

      if (params.has_bank_account === false && elig.requires_bank_account) {
        dealbreakers.push("This lender requires an active bank account");
      }

      if (params.has_bankruptcy && elig.bankruptcy_restriction) {
        if (elig.bankruptcy_restriction === "none") {
          matchReasons.push("This lender has no bankruptcy restrictions");
        } else {
          caveats.push(`Bankruptcy restriction: ${elig.bankruptcy_restriction}`);
        }
      }

      if (elig.offers_prequalification) {
        matchReasons.push(`Offers prequalification${elig.prequal_is_soft_pull ? ' with soft pull (no credit impact)' : ''}`);
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
      overallAssessment = "❓ **Insufficient Data** — we don't have enough information to assess eligibility";
    }

    const lines: string[] = [
      `# Eligibility Check: ${lender.display_name}`,
      '',
      overallAssessment,
      '',
    ];

    if (matchReasons.length > 0) {
      lines.push(`## ✅ Why this could work`);
      matchReasons.forEach(r => lines.push(`- ${r}`));
      lines.push('');
    }

    if (caveats.length > 0) {
      lines.push(`## 🟡 Things to verify`);
      caveats.forEach(c => lines.push(`- ${c}`));
      lines.push('');
    }

    if (dealbreakers.length > 0) {
      lines.push(`## ❌ Potential issues`);
      dealbreakers.forEach(d => lines.push(`- ${d}`));
      lines.push('');
    }

    if (products.length > 0) {
      const p = products[0];
      lines.push(`## Product Snapshot`);
      if (p.apr_min || p.apr_max) lines.push(`- **APR:** ${p.apr_min ?? '?'}% – ${p.apr_max ?? '?'}%`);
      if (p.min_amount || p.max_amount) lines.push(`- **Amount:** $${p.min_amount?.toLocaleString() ?? '?'} – $${p.max_amount?.toLocaleString() ?? '?'}`);
      if (p.funding_speed) lines.push(`- **Funding:** ${p.funding_speed}`);

      if (params.loan_amount && p.apr_typical && p.term_max_months) {
        const payment = calcMonthlyPayment(params.loan_amount, p.apr_typical, p.term_max_months);
        lines.push(`- **Est. Payment:** ~$${Math.round(payment)}/mo (at ${p.apr_typical}% for ${p.term_max_months} mo)`);
      }
      lines.push('');
    }

    lines.push(`---`);
    lines.push(`_This is an automated assessment based on available data and may not reflect the lender's current requirements. Always verify directly with the lender before applying. Data confidence: ${lender.data_confidence ?? 0}%._`);

    return {
      content: [{
        type: "text" as const,
        text: lines.join('\n'),
      }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LenderWiki MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
