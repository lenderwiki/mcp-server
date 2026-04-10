# LenderWiki MCP Server

  A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI assistants access to LenderWiki's database of **13,000+ US consumer lenders**. Search, compare, and analyze personal loan providers with real data on rates, fees, eligibility, customer reviews, and regulatory history.

  <div align="center">

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![MCP](https://img.shields.io/badge/MCP-1.0-green.svg)](https://modelcontextprotocol.io)
  [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

  </div>

  ## What It Does

  This server exposes four tools that any MCP-compatible AI client (Claude Desktop, Cursor, Windsurf, etc.) can use to query LenderWiki's live database:

  | Tool | Description |
  |------|-------------|
  | `find_lenders` | Search lenders by state, type, credit score, loan amount range, ITIN acceptance, and more |
  | `get_lender_profile` | Get a comprehensive lender profile — products, rates, eligibility, reviews, regulatory status |
  | `compare_lenders` | Side-by-side comparison table for 2–5 lenders |
  | `check_eligibility` | Preliminary eligibility check based on a user's financial profile |

  ### Example Prompts

  Once connected, you can ask your AI assistant things like:

  - *"Find lenders in California that accept ITIN"*
  - *"Show me Upstart's full profile — rates, fees, who can apply"*
  - *"Compare SoFi vs LendingClub vs Avant side by side"*
  - *"I have a 620 credit score, $45k income, and I'm in Texas. Check if I'm eligible for Oportun"*
  - *"What lenders accept applicants with no credit history?"*
  - *"Find online lenders with loan amounts between $5,000 and $20,000"*

  ## Quick Start

  ### 1. Get a Free API Key

  Sign up at [lenderwiki.com](https://lenderwiki.com) for a free API key (1,000 requests/day).

  ### 2. Install

  ```bash
  npm install lenderwiki-mcp-server
  ```

  Or clone and build from source:

  ```bash
  git clone https://github.com/lenderwiki/mcp-server.git
  cd lenderwiki-mcp-server
  npm install
  npm run build
  ```

  ### 3. Configure Your MCP Client

  #### Claude Desktop

  Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

  ```json
  {
    "mcpServers": {
      "lenderwiki": {
        "command": "node",
        "args": ["/path/to/lenderwiki-mcp-server/dist/index.mjs"],
        "env": {
          "LENDERWIKI_API_KEY": "your-api-key-here"
        }
      }
    }
  }
  ```

  #### Cursor

  Add to your Cursor MCP settings (`.cursor/mcp.json`):

  ```json
  {
    "mcpServers": {
      "lenderwiki": {
        "command": "node",
        "args": ["/path/to/lenderwiki-mcp-server/dist/index.mjs"],
        "env": {
          "LENDERWIKI_API_KEY": "your-api-key-here"
        }
      }
    }
  }
  ```

  #### Windsurf

  Add to your Windsurf MCP config (`~/.codeium/windsurf/mcp_config.json`):

  ```json
  {
    "mcpServers": {
      "lenderwiki": {
        "command": "node",
        "args": ["/path/to/lenderwiki-mcp-server/dist/index.mjs"],
        "env": {
          "LENDERWIKI_API_KEY": "your-api-key-here"
        }
      }
    }
  }
  ```

  #### npx (No Installation)

  If published to npm, you can use it directly:

  ```json
  {
    "mcpServers": {
      "lenderwiki": {
        "command": "npx",
        "args": ["lenderwiki-mcp-server"],
        "env": {
          "LENDERWIKI_API_KEY": "your-api-key-here"
        }
      }
    }
  }
  ```



    ## Hosted HTTP Endpoint (Smithery / Remote MCP)

    LenderWiki also hosts the MCP server over HTTP so you can connect without running anything locally.

    ### Streamable HTTP (Recommended)

    **Endpoint:** `https://lenderwiki.com/api/mcp`

    This implements the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http). Use this for Smithery, remote MCP clients, and any tool that supports HTTP-based MCP.

    ```
    POST https://lenderwiki.com/api/mcp
    Content-Type: application/json
    Accept: application/json, text/event-stream
    ```

    ### Legacy SSE

    For clients that only support the older SSE transport:

    - **SSE endpoint:** `GET https://lenderwiki.com/api/sse`
    - **Message endpoint:** `POST https://lenderwiki.com/api/messages?sessionId=<id>`

    ### Smithery Configuration

    When submitting to Smithery, use:

    - **Transport:** Streamable HTTP
    - **URL:** `https://lenderwiki.com/api/mcp`
    - **Authentication:** None required (rate-limited by IP)
    
  ## Tools Reference

  ### `find_lenders`

  Search the lender database with optional filters.

  **Parameters:**

  | Parameter | Type | Description |
  |-----------|------|-------------|
  | `state` | string | Two-letter US state code (e.g. `"CA"`) |
  | `lender_type` | enum | `online`, `bank`, `credit_union`, `cdfi`, `nonprofit`, `tribal`, `fintech` |
  | `accepts_itin` | boolean | Filter for ITIN-accepting lenders |
  | `min_amount` | number | Minimum loan amount needed — filters to lenders offering at least this amount |
  | `max_amount` | number | Maximum loan amount needed — filters to lenders whose minimum is at or below this amount |
  | `credit_score` | number | Filter to lenders accepting this score |
  | `limit` | number | Max results, 1–50 (default 10) |

  **Example tool call:**

  ```json
  {
    "name": "find_lenders",
    "arguments": {
      "state": "CA",
      "accepts_itin": true,
      "min_amount": 5000,
      "limit": 5
    }
  }
  ```

  **Response format:** Markdown text listing each matching lender with display name, type, state, data confidence, editorial verdict, BBB and Google ratings, CFPB complaint count, ITIN acceptance, customer praise/warnings, website URL, and LenderWiki profile link.

  ### `get_lender_profile`

  Retrieve a complete lender profile.

  **Parameters:**

  | Parameter | Type | Description |
  |-----------|------|-------------|
  | `slug` | string | Lender identifier (e.g. `"upstart"`, `"sofi"`) |

  **Example tool call:**

  ```json
  {
    "name": "get_lender_profile",
    "arguments": {
      "slug": "upstart"
    }
  }
  ```

  **Response format:** Markdown document with sections: About, Key Facts (legal name, type, NMLS ID, headquarters, website, data confidence), What It Costs (per-product APR ranges, origination fees, terms, funding speed, estimated monthly payment), Who Can Apply (credit score, income, employment, ITIN/SSN, bankruptcy restrictions, prequalification), What Customers Say (Google/BBB ratings, praise, warnings, editorial verdict), Customer Complaints (CFPB data), and Regulatory Status.

  ### `compare_lenders`

  Generate a side-by-side comparison.

  **Parameters:**

  | Parameter | Type | Description |
  |-----------|------|-------------|
  | `slugs` | string[] | 2–5 lender slugs to compare |

  **Example tool call:**

  ```json
  {
    "name": "compare_lenders",
    "arguments": {
      "slugs": ["upstart", "lending-club", "sofi"]
    }
  }
  ```

  **Response format:** Markdown with a comparison table per lender showing: type, headquarters, APR range, loan amount range, max term, origination fee, funding speed, min credit score, credit check type, ITIN acceptance, no-credit acceptance, prequalification, BBB rating, Google rating, CFPB complaints, warnings, and data confidence.

  ### `check_eligibility`

  Assess likely eligibility for a specific lender.

  **Parameters:**

  | Parameter | Type | Description |
  |-----------|------|-------------|
  | `slug` | string | Lender slug |
  | `credit_score` | number | Applicant's score (300–850) |
  | `annual_income` | number | Gross annual income in USD |
  | `state` | string | Two-letter state code |
  | `employment_type` | enum | `W2`, `self_employed`, `1099`, `gig`, `unemployed`, `retired`, `student` |
  | `has_itin` | boolean | Uses ITIN instead of SSN |
  | `loan_amount` | number | Desired amount in USD |
  | `has_bank_account` | boolean | Has active bank account |
  | `has_bankruptcy` | boolean | Has bankruptcy on record |

  **Example tool call:**

  ```json
  {
    "name": "check_eligibility",
    "arguments": {
      "slug": "oportun",
      "credit_score": 620,
      "annual_income": 45000,
      "state": "TX",
      "employment_type": "W2",
      "loan_amount": 5000
    }
  }
  ```

  **Response format:** Markdown with an overall assessment (✅ Likely Match / 🟡 Possible Match / ❌ Unlikely Match / ❓ Insufficient Data), followed by sections for match reasons, things to verify, potential issues, and a product snapshot with estimated monthly payment.

  ## Environment Variables

  | Variable | Required | Default | Description |
  |----------|----------|---------|-------------|
  | `LENDERWIKI_API_KEY` | Recommended | — | Your free LenderWiki API key |
  | `LENDERWIKI_API_URL` | No | `https://lenderwiki.com/api/v1` | API base URL (for self-hosting or development) |

  ## Data Coverage

  LenderWiki tracks **13,000+ US consumer lenders** across these categories:

  - Online lenders & fintechs (Upstart, SoFi, LendingClub, etc.)
  - Banks & credit unions
  - CDFIs (Community Development Financial Institutions)
  - Nonprofit lenders
  - Tribal lenders

  Each lender profile may include:

  - **Products** — APR ranges, loan amounts, terms, origination fees, funding speed
  - **Eligibility** — Credit score minimums, income requirements, employment types, ITIN/SSN, bankruptcy restrictions
  - **Customer Feedback** — Google ratings, BBB ratings, common praises and warnings
  - **Regulatory** — CFPB complaint counts/trends, active warnings, enforcement actions
  - **Editorial** — LenderWiki's editorial verdict and data confidence score

  Data is sourced from lender websites, NerdWallet, Bankrate, CFPB, BBB, and regulatory databases. Each record includes a `data_confidence` score (0–100%) and `last_verified_at` timestamp.

  ## Development

  ```bash
  git clone https://github.com/lenderwiki/mcp-server.git
  cd lenderwiki-mcp-server
  npm install
  npm run build
  ```

  Test locally:

  ```bash
  LENDERWIKI_API_KEY=your-key node dist/index.mjs
  ```

  The server communicates over stdio (stdin/stdout) using the MCP protocol. It does not start an HTTP server.

  ## Disclaimer

  LenderWiki data is for informational purposes only and does not constitute financial advice. Always verify eligibility requirements directly with the lender before applying. Data accuracy varies by lender — check the `data_confidence` score on each profile.

  ## License

  [MIT](LICENSE)

  ---

  Built by [LenderWiki](https://lenderwiki.com) — the comprehensive database of US consumer lenders.
  