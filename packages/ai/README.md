# @budget/ai — OpenAI integration

The only place in the codebase that calls OpenAI. Implements AI features like smart search suggestions and semantic understanding. All LLM calls go through this package.

## Running tests

```bash
pnpm --filter @budget/ai test
```

Tests cover prompt generation, response parsing, and error handling. Mock responses are used; no real API calls in tests.

## Usage

This package is imported by `@budget/api` and `@budget/web` for AI-powered features. All OpenAI configuration (model, API key, rate limits) is centralized here.

## Non-negotiables

- OpenAI only (no Gemini, Claude, or other providers)
- All calls logged with `requestId`, `userId`, and tokens used
- Errors are caught and handled gracefully (never crash the user's request)
- No sensitive data is sent to OpenAI (workspace data is never included in prompts)
