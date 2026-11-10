# ResolveAI — AI-Powered Dispute Resolution Platform

ResolveAI is an AI-assisted dispute and complaint resolution platform built for the PayPal AI Hackathon. It provides separate Customer and Merchant experiences for managing complaints, reviewing transaction disputes, and supporting resolution workflows.

## Repository

https://github.com/n-idhigupta/resolve-ai

## Features

- Customer dashboard for transactions and complaints
- Merchant dashboard for dispute and case management
- AI-assisted dispute analysis and resolution recommendations
- PayPal Sandbox integration for payment workflow testing
- Role-based authentication and tenant isolation
- Case management and status tracking
- PostgreSQL row-level security and CSRF protection

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, Fastify |
| Database | PostgreSQL, Prisma |
| Cache and Queue | Redis, BullMQ |
| AI | Google Gemini |
| Payments | PayPal Sandbox |

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/n-idhigupta/resolve-ai.git
cd resolve-ai
```

### 2. Install dependencies

```bash
pnpm install
```

Ensure PostgreSQL and Redis are running, and configure the environment variables according to `docs/DEMO.md`.

### 3. Prepare the demo

```bash
pnpm demo:hackathon
```

### 4. Start the application

```bash
pnpm demo:start
```

### 5. Open the login page

**http://localhost:5173/**

Select **Customer** or **Merchant** and sign in with the appropriate demo account.

## Demo Credentials

| Role | Email |
|---|---|
| Customer | `dollar-customer@resolveai.test` |
| Merchant | `settlement-merchant-5887a75e@resolveai.test` |

Both seeded accounts use the password configured locally as `DEV_SEED_PASSWORD`.

The password is intentionally not included in this repository. Refer to `docs/DEMO.md` for demo setup.

## Demo Walkthrough

1. Open http://localhost:5173/.
2. Select Customer and sign in.
3. View the customer dashboard and demo transactions.
4. Create an internal complaint.
5. Sign out.
6. Return to the login page and select Merchant.
7. Sign in with the merchant demo account.
8. Review cases in the Merchant dashboard.

## Documentation

- `docs/DEMO.md` — Local demo instructions
- `docs/FREE-DEMO.md` — Free deployment configuration
- `docs/RENDER.md` — Render deployment documentation

## Deployment

The application is runnable locally. A public Render deployment has not yet been verified.

## Security

- Demo accounts and records are synthetic.
- PayPal financial operations must remain within the approved Sandbox testing workflow.
- Real AI calls require explicit authorization.
- Authentication, CSRF protection, and tenant isolation must remain enabled.
- Never commit passwords, API keys, or database credentials.

## Hackathon

**Project:** ResolveAI

**Purpose:** Simplify payment dispute management through AI-assisted workflows for customers and merchants.