# DecentralThink Twin

**Authentic Digital Twin — Layer 3 vertical built on [DecentralThink Core](https://core.decentralthink.com)**

**Built by [Dr. Nikhil Varma](https://decentralthink.com)**  
Associate Professor · Ramapo College of New Jersey · Former Head of Ecosystem (India), Algorand Foundation · Author, *Blockchain Capitalism*

> *Every other AI clone maximises coverage. This one deliberately constrains it.*

A privacy-sovereign digital twin that is:
- **Constrained** to only what the person verifiably knows (knowledge boundary by absence)
- **Authentic** — stylistically calibrated to sound like them, not like a generic AI
- **Transparent** — every training document hashed, signed by the owner's wallet, logged immutably on Algorand

---

## The Three Fatal Flaws This Solves

| Problem with every other twin | How DecentralThink Twin solves it |
|---|---|
| **Knowledge hallucination** — claims expertise the person doesn't have | Knowledge boundary by *absence*: no RAG match = no answer, period |
| **Generic AI voice** — sounds like ChatGPT, not the person | Style Fingerprint: extracts HOW they communicate, not just WHAT they know |
| **Opaque training** — nobody knows what data trained it | Provenance chain: every document hashed, wallet-signed, anchored to Algorand |

---

## Architecture

```
Caller query
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  DecentralThink Twin API  (this repo)                   │
│                                                         │
│  1. Policy check (OPA) ──────────────────────────────→  Core OPA
│  2. RAG retrieval ───────────────────────────────────→  Qdrant (TEE)
│  3. Boundary scoring (0.0 – 1.0)                       │
│  4. Style-guided generation ─────────────────────────→  Ollama Hermes
│  5. Audit log ───────────────────────────────────────→  Core → Algorand
└─────────────────────────────────────────────────────────┘
              │
              ▼
    Response in the person's voice
    with confidence level attached
```

### Knowledge Boundary Scoring

| Score | Behaviour |
|---|---|
| **0.85 – 1.0** Strong match | Responds with full confidence |
| **0.70 – 0.84** Partial match | Responds with appropriate hedging: *"I've worked around this but I'm not the deepest expert..."* |
| **0.40 – 0.69** Weak match | Acknowledges tangentially, defers: *"I've come across this but I'd defer to a specialist..."* |
| **< 0.40** No match | Clean deferral in the person's natural voice |

### Integration with DecentralThink Core

The twin does **not** re-implement what Core already provides:

| Twin Feature | Core Layer | Endpoint |
|---|---|---|
| Training document encryption | Sovereign Vault | `POST /api/v1/vault` |
| Provenance chain | Blockchain Audit (Algorand) | `POST /api/v1/audit` |
| Per-query billing | x402 Payments | `POST /api/v1/payments` |
| Access control & consent | OPA Policy Engine | via invoke |
| Authentication | SIWE (Sign-In With Ethereum) | `POST /api/v1/auth/verify` |
| Twin registration | ZK Marketplace | `POST /api/v1/marketplace` |

---

## Supported Training Sources

| Source Type | How to provide | What gets extracted |
|---|---|---|
| **Text / Markdown** | File upload | Full text |
| **PDF** | File upload | Text extraction (all pages) |
| **Word (.docx)** | File upload | Raw text |
| **PowerPoint (.pptx)** | File upload | Slide text + speaker notes |
| **Web URL** | URL ingest | Main article content (noise-stripped) |
| **YouTube video** | YouTube URL | Auto-captions → Whisper fallback |
| **Audio file** | File upload (.mp3/.wav/.m4a) | Whisper transcription |
| **Video file** | File upload (.mp4/.mov/.webm) | ffmpeg → Whisper transcription |
| **LinkedIn profile** | PDF or data export | Profile, articles, recommendations |
| **Twitter/X archive** | tweets.js export | Own tweets (retweets excluded) |
| **Email** | .eml or .mbox export | Body text (third-party PII stripped) |
| **Slack export** | JSON channel export | Owner's messages only |
| **Teams export** | JSON export | Owner's messages only |
| **GitHub repo** | GitHub URL | README, commit messages, docs, issues |
| **Raw text / bio** | Paste via API | Full text |
| **Batch URLs** | Array of URLs | Up to 20 URLs in one request |

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- [DecentralThink Core](https://github.com/nikhilvarma283/decentralthinkcore) running locally or at `core.decentralthink.com`
- Ollama with required models (see below)

### 1. Clone and Configure

```bash
git clone git@github.com:nikhilvarma283/decentralthink-twin.git
cd decentralthink-twin
cp .env.example .env
```

Key variables in `.env`:

```env
CORE_API_URL=http://localhost:3001    # or https://core.decentralthink.com
CORE_API_KEY=your_internal_service_key
OLLAMA_URL=http://host.docker.internal:11434
```

### 2. Pull required models

```bash
# Embedding model (for RAG)
ollama pull nomic-embed-text

# Inference model (for style-guided responses)
ollama pull nous-hermes2
```

### 3. Launch

```bash
docker compose up --build
```

Starts:
- **Twin API** on port `3002`
- **Qdrant** vector DB on port `6333`

### 4. Verify

```bash
curl http://localhost:3002/health
```

Expected:
```json
{
  "status": "ok",
  "checks": { "api": "ok", "qdrant": "ok", "core": "ok", "ollama": "ok" }
}
```

---

## API Reference

All endpoints under `/api/v1/`. Auth via headers:
- `x-session-token` — obtained from Core's SIWE auth (`POST core/api/v1/auth/verify`)
- `x-wallet-address` — the owner's Ethereum wallet address

### Onboarding

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/onboarding/start` | POST | Step 1: record identity after SIWE sign-in |
| `/api/v1/onboarding/:twinId/state` | GET | Get current onboarding progress |
| `/api/v1/onboarding/:twinId/style` | POST | Step 3: trigger style fingerprint extraction |
| `/api/v1/onboarding/:twinId/domains` | POST | Step 4: generate domain ontology |
| `/api/v1/onboarding/:twinId/domains/approve` | POST | Step 4: approve/edit domain list |
| `/api/v1/onboarding/:twinId/sandbox` | GET | Test twin before activation (`?q=your+question`) |
| `/api/v1/onboarding/:twinId/activate` | POST | Step 5: mint Soul Token, go live |

### Training / Ingestion

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/ingest/file` | POST | Upload any file (multipart/form-data) |
| `/api/v1/ingest/url` | POST | Ingest a URL or YouTube link |
| `/api/v1/ingest/text` | POST | Paste raw text or bio |
| `/api/v1/ingest/batch` | POST | Batch ingest up to 20 URLs |
| `/api/v1/ingest/status/:jobId` | GET | Poll async job status |
| `/api/v1/documents` | GET | Full provenance manifest (from Algorand) |
| `/api/v1/documents/:id` | DELETE | Remove document (right to forget) |

### Style Fingerprint

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/style/extract` | POST | Extract fingerprint from communication samples |
| `/api/v1/style` | GET | Get current fingerprint |
| `/api/v1/style` | PUT | Manually adjust fingerprint |

### Billing & Access

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/v1/billing/:twinId/pricing` | GET | None | What does this twin charge? |
| `/api/v1/billing/:twinId/pricing` | PUT | Owner | Set price per query + free tier |
| `/api/v1/billing/:twinId/earnings` | GET | Owner | Revenue dashboard (gross / net / by-day) |
| `/api/v1/billing/:twinId/usage` | GET | Owner | Query volume + top callers |
| `/api/v1/billing/:twinId/grants` | GET | Owner | List access grants |
| `/api/v1/billing/:twinId/grants` | POST | Owner | Grant org access |
| `/api/v1/billing/:twinId/grants/:addr` | DELETE | Owner | Revoke access |

### Twin Query

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/query` | POST | Ask the twin (grant check + billing gate + style-guided answer) |

### Examples

**Ingest a YouTube video:**
```bash
curl -X POST http://localhost:3002/api/v1/ingest/url \
  -H "Content-Type: application/json" \
  -H "x-session-token: <token>" \
  -H "x-wallet-address: 0x..." \
  -d '{"url": "https://youtube.com/watch?v=...", "category": "transcripts"}'
```

**Ingest a LinkedIn PDF export:**
```bash
curl -X POST http://localhost:3002/api/v1/ingest/file \
  -H "x-session-token: <token>" \
  -H "x-wallet-address: 0x..." \
  -F "file=@NikhilVarma_LinkedIn.pdf" \
  -F "category=linkedin_export"
```

**Batch ingest articles:**
```bash
curl -X POST http://localhost:3002/api/v1/ingest/batch \
  -H "Content-Type: application/json" \
  -H "x-session-token: <token>" \
  -H "x-wallet-address: 0x..." \
  -d '{"urls": ["https://...", "https://..."], "category": "articles"}'
```

**Set pricing (owner):**
```bash
curl -X PUT http://localhost:3002/api/v1/billing/twin_abc/pricing \
  -H "Content-Type: application/json" \
  -H "x-session-token: <owner-token>" \
  -d '{"pricePerQuery": 0.05, "queryLimitFree": 10}'
```

**Query the twin (first 10/day free, then paid):**
```bash
curl -X POST http://localhost:3002/api/v1/query \
  -H "Content-Type: application/json" \
  -H "x-session-token: <token>" \
  -H "x-wallet-address: 0x..." \
  -d '{
    "twinId": "twin_abc",
    "twinOwner": "0x...",
    "query": "What is your view on TEE-based AI execution?",
    "context": "qa"
  }'
```

HTTP 402 response (free tier exhausted):
```json
{
  "error": "Payment required",
  "queryId": "query_1234_abc",
  "x402": {
    "amount": 0.05,
    "currency": "USDC",
    "paymentUrl": "https://core.decentralthink.com/api/v1/payments/pay/pay_xyz",
    "paymentId": "pay_xyz",
    "scheme": "exact",
    "network": "algorand"
  }
}
```

Retry after payment:
```bash
curl -X POST http://localhost:3002/api/v1/query \
  -H "x-session-token: <token>" \
  -H "x-wallet-address: 0x..." \
  -H "X-Payment-Receipt: pay_xyz" \
  -d '{ "twinId": "twin_abc", "twinOwner": "0x...", "query": "..." }'
```

Successful response:
```json
{
  "queryId": "query_1234_abc",
  "answer": "The response in the person's exact voice...",
  "confidence": "strong",
  "boundaryScore": 0.91,
  "billing": {
    "charged": true,
    "amount": 0.05,
    "currency": "USDC"
  }
}
```

---

## Directory Structure

```
decentralthink-twin/
├── src/
│   ├── api/v1/
│   │   ├── ingest.js          Unified ingest API (file/url/text/batch) + anti-enhancement gate
│   │   ├── onboarding.js      5-step onboarding REST API + sandbox endpoint
│   │   ├── billing.js         Pricing, earnings, access grants
│   │   ├── documents.js       Document management + provenance
│   │   ├── query.js           Twin query endpoint (with billing gate + grant check)
│   │   └── style.js           Style fingerprint API
│   ├── core/
│   │   └── client.js          DecentralThink Core API client (all Layer 1 calls)
│   ├── knowledge/
│   │   ├── ingest.js          Provenance pipeline (hash→vault→audit→embed→Qdrant)
│   │   ├── validation/
│   │   │   └── antiEnhancement.js  AI detection + generic reference + personal signal
│   │   └── extractors/
│   │       ├── index.js       Extractor router (type detection)
│   │       ├── text.js        Plain text / Markdown
│   │       ├── pdf.js         PDF extraction
│   │       ├── docx.js        Word documents
│   │       ├── pptx.js        PowerPoint presentations
│   │       ├── url.js         Web page scraping
│   │       ├── youtube.js     YouTube transcript + Whisper fallback
│   │       ├── audioVideo.js  Audio/video → Whisper transcription
│   │       ├── profile.js     LinkedIn + Twitter/X exports
│   │       ├── email.js       .eml + .mbox email exports
│   │       ├── chat.js        Slack + Teams exports
│   │       └── github.js      GitHub repo (README, commits, docs)
│   ├── billing/
│   │   └── x402.js            x402 billing gate, pricing CRUD, earnings/usage tracking
│   ├── onboarding/
│   │   └── flow.js            5-step state machine (persisted in Core Vault)
│   ├── soultoken/
│   │   └── index.js           Algorand Soul Token (ASA, soulbound, ARC-3, grant/revoke)
│   ├── style/
│   │   └── fingerprint.js     Style Fingerprint extraction + prompt builder
│   ├── twin/
│   │   └── engine.js          Query pipeline (policy→RAG→boundary→generate→audit)
│   └── lib/
│       └── logger.js
├── tests/
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CORE_API_URL` | Yes | DecentralThink Core base URL |
| `CORE_API_KEY` | Yes | Internal service key for Core API |
| `QDRANT_URL` | Yes | Qdrant vector DB URL |
| `OLLAMA_URL` | Yes | Ollama inference server URL |
| `EMBEDDING_MODEL` | No | Embedding model (default: `nomic-embed-text`) |
| `INFERENCE_MODEL` | No | Inference model (default: `nous-hermes2`) |
| `BOUNDARY_STRONG` | No | Strong confidence threshold (default: `0.85`) |
| `BOUNDARY_PARTIAL` | No | Partial confidence threshold (default: `0.70`) |
| `BOUNDARY_WEAK` | No | Weak confidence threshold (default: `0.40`) |
| `OPENAI_API_KEY` | No | Fallback for Whisper transcription |
| `GITHUB_TOKEN` | No | GitHub PAT for private repo access |
| `ALGORAND_NODE` | No | Algorand node URL (default: testnet AlgoNode) |
| `ALGORAND_INDEXER` | No | Algorand indexer URL (default: testnet AlgoNode) |
| `ONBOARDING_MIN_DOCS` | No | Min docs before advancing from Step 2 (default: `3`) |
| `ONBOARDING_MIN_WORDS` | No | Min words before advancing from Step 2 (default: `500`) |

---

## Sprint Log

### ✅ Sprint 1 — Foundation
*Completed: May 2026*

**Built:**
- Repo scaffold — Express API, Qdrant, Docker Compose
- `src/core/client.js` — unified DecentralThink Core API client covering vault, audit, payments, policy, auth, and marketplace
- Document ingestion pipeline: upload → SHA-256 hash → Algorand provenance log → Sovereign Vault encryption → chunk → embed → Qdrant
- Document removal (right to forget): Qdrant deletion + Vault deletion + audit log
- Provenance manifest endpoint: full audit trail from Algorand
- Health check: api, qdrant, core, ollama

**Core primitives used:** Sovereign Vault, Blockchain Audit Chain

---

### ✅ Sprint 2 — RAG Pipeline + Twin Engine
*Completed: May 2026*

**Built:**
- `src/knowledge/ingest.js` — full provenance + RAG pipeline
- `src/twin/engine.js` — query pipeline: OPA policy check → RAG retrieval → boundary scoring → style-guided generation → audit log
- Boundary scoring: strong (0.85+) / partial (0.70+) / weak (0.40+) / none — each with distinct response behaviour
- Deferral responses: clean, natural-sounding rejections when outside knowledge boundary
- Query audit log: metadata only, never the actual query text (privacy by design)

**Core primitives used:** OPA Policy Engine, x402 Payments (stub), Blockchain Audit

---

### ✅ Sprint 3 — Style Fingerprint
*Completed: May 2026*

**Built:**
- `src/style/fingerprint.js` — NLP style extraction from communication samples
- Style Fingerprint JSON: voice, writing patterns, explanation style, deferral templates, few-shot exemplars
- Context-aware tone switching: email vs chat vs document vs Q&A
- Anti-AI-sounding rules baked into every system prompt
- Style stored encrypted in Core's Sovereign Vault
- `POST /api/v1/style/extract` — extract from uploaded samples
- `GET/PUT /api/v1/style` — read and manually adjust

**Core primitives used:** Sovereign Vault, Blockchain Audit

---

### ✅ Sprint 4 — Flexible Training Ingestion
*Completed: May 2026*

**Built:**
- `src/knowledge/extractors/` — plugin-style extractor system, 12 content types:
  - Text, PDF, DOCX, PPTX, URL scraping, YouTube (captions + Whisper), Audio/Video (Whisper), LinkedIn export, Twitter/X archive, Email (.eml/.mbox), Slack/Teams chat, GitHub repo
- `POST /api/v1/ingest/file` — any file type, auto-detected
- `POST /api/v1/ingest/url` — any URL (web, YouTube, GitHub)
- `POST /api/v1/ingest/text` — raw paste / bio
- `POST /api/v1/ingest/batch` — up to 20 URLs concurrently
- `GET /api/v1/ingest/status/:jobId` — async job tracking for large files
- PII stripping in email extractor (third-party emails/phones anonymised)
- YouTube: captions-first, Whisper audio fallback

---

### ✅ Sprint 5 — Onboarding Flow + Soul Token
*Completed: May 2026*

**Built:**
- `src/onboarding/flow.js` — 5-step onboarding state machine persisted in Core Vault
  - Step 1: Identity (wallet connect via SIWE, Qdrant collection creation, ZK Marketplace registration)
  - Step 2: Knowledge upload (progress tracked; thresholds: 3+ docs, 500+ words before advancing)
  - Step 3: Style calibration (auto-gathers writing samples from ingested docs, extracts fingerprint via Ollama)
  - Step 4: Domain ontology (LLM-generated domains, owner reviews + approves before lock-in)
  - Step 5: Twin activation (Soul Token minted, twin goes live)
- `src/api/v1/onboarding.js` — REST endpoints for all 5 steps:
  - `POST /api/v1/onboarding/start` — Step 1
  - `GET  /api/v1/onboarding/:twinId/state` — progress polling
  - `POST /api/v1/onboarding/:twinId/style` — Step 3
  - `POST /api/v1/onboarding/:twinId/domains` — generate ontology
  - `POST /api/v1/onboarding/:twinId/domains/approve` — Step 4 confirm
  - `GET  /api/v1/onboarding/:twinId/sandbox?q=` — test twin before activation
  - `POST /api/v1/onboarding/:twinId/activate` — Step 5 (mints Soul Token)
- `src/soultoken/index.js` — Algorand ASA Soul Token (total=1, soulbound via clawback, ARC-3 metadata)
  - `mintSoulToken()`, `grantAccess()`, `verifyAccess()`, `revokeAccess()`, `getSoulToken()`
- `src/knowledge/validation/antiEnhancement.js` — Anti-enhancement validator (wired into all ingest routes)
  - 5 checks: AI content patterns, generic reference material, personal signal, category mismatch, bulk suspicious
  - **Blocks** content when `aiScore > 0.85 AND personalScore < 0.1` (HTTP 422)
  - **Warns** with detail when below block threshold (returned alongside successful ingest)
- Sandbox mode in query engine — owner tests their twin without audit logs or policy checks

**Core primitives used:** Sovereign Vault (onboarding state), Blockchain Audit (all step events), ZK Marketplace (registration), Algorand (Soul Token ASA)

---

### ✅ Sprint 6 — x402 Per-Query Billing
*Completed: May 2026*

**Built:**
- `src/billing/x402.js` — full billing layer:
  - `getPricing()` / `setPricing()` — per-twin pricing config stored in Core Vault (pricePerQuery, queryLimitFree, active flag)
  - `billingGate()` — evaluates every query: owner access → free tier → payment receipt check → issue HTTP 402 challenge
  - Free-tier usage tracked per-caller per-day in Core Vault (daily bucket keys)
  - `getEarnings()` — revenue dashboard from Algorand audit log (gross / platform fee / net / by-day breakdown)
  - `getUsageStats()` — query volume, confidence distribution, top callers
- `src/api/v1/billing.js` — REST endpoints:
  - `GET  /api/v1/billing/:twinId/pricing` — **public** (no auth): what does this twin charge?
  - `PUT  /api/v1/billing/:twinId/pricing` — owner sets price per query + free tier
  - `GET  /api/v1/billing/:twinId/earnings` — revenue dashboard (30-day default)
  - `GET  /api/v1/billing/:twinId/usage` — query stats + top callers
  - `GET  /api/v1/billing/:twinId/grants` — list access grants
  - `POST /api/v1/billing/:twinId/grants` — grant org access
  - `DELETE /api/v1/billing/:twinId/grants/:addr` — revoke access
- `src/api/v1/query.js` — fully rewired with the billing gate:
  - Step 1: Soul Token grant check (403 if no grant)
  - Step 2: Billing gate (HTTP 402 with x402 challenge if unpaid)
  - Step 3: Style fingerprint load from Core Vault
  - Step 4: Query engine
  - Step 5: Paid-query audit event on Algorand
  - `billing: { charged, amount, freeTierUsed, freeTierRemaining }` in every response
- HTTP 402 response includes full x402 challenge (paymentUrl, paymentId, scheme, network, amount) — caller retries with `X-Payment-Receipt: <paymentId>`

**Core primitives used:** x402 Payments, Sovereign Vault (pricing + usage counters), Blockchain Audit (paid query events)

---

### 🔜 Sprint 7 — MCP Agent-to-Agent Interface
*Planned*

**Planned:**
- Model Context Protocol endpoint for agent-to-agent queries
- Same boundary and consent rules apply
- MCP tool definitions published to Core's ZK Marketplace
- Composite workflows: query multiple twins, combine responses
- Example: "Ask Dr. Varma's twin about architecture → ask legal twin about compliance → generate report"

---

### 🔜 Sprint 8 — Email & Calendar Integration
*Planned*

**Planned:**
- Gmail/Outlook OAuth (read-only by default)
- Draft emails in the twin owner's voice
- Review queue before sending
- Calendar awareness: check availability, prep briefing docs
- Post-meeting: auto-draft follow-up emails from notes

---

### 🔜 Sprint 9 — Production Deployment
*Planned*

**Planned:**
- Deploy to VPS alongside DecentralThink Core
- Subdomain: `twin.decentralthink.com`
- Traefik TLS via Let's Encrypt
- Qdrant persistence + backup
- Rate limiting per twin owner
- Monitoring + alerting

---

## Security & Privacy Model

| Guarantee | How |
|---|---|
| Server never sees training data plaintext | Documents encrypted client-side, stored in Core's Sovereign Vault (AES-256-GCM) |
| Training provenance is verifiable | Every document hashed (SHA-256), owner-signed (wallet), anchored to Algorand |
| Twin can't exceed the person's real expertise | Knowledge boundary by absence — no RAG match = no answer |
| Query content never logged | Audit records metadata only (query length, confidence score) — never the query text |
| Right to forget | Any document can be removed: Qdrant deletion + Vault deletion + audit log entry |
| Access controlled | Soul Token (consent NFT) required — encodes scopes, expiry, limits |

---

## Patent Notice

This product implements architecture described in a provisional patent filed February 18, 2026 by Dr. Nikhil Varma. The Authentic Digital Twin system — including the knowledge boundary by absence, Style Fingerprint extraction, and provenance chain — constitutes a patent-pending claim built on the DecentralThink Core infrastructure layer.

---

## Builder

**Dr. Nikhil Varma**  
Founder, DecentralThink  
Associate Professor, Ramapo College of New Jersey  
Former Head of Ecosystem Success (India), Algorand Foundation  
Author, *Blockchain Capitalism*  
[decentralthink.com](https://decentralthink.com) · [LinkedIn](https://www.linkedin.com/company/decentralailabs)

---

## License

Proprietary — All rights reserved. Contact [decentralthink.com](https://decentralthink.com) for licensing inquiries.
