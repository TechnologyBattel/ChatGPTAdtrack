# AdTrack (ChatGPTAdtrack)

Ask a plain-language question about ChatGPT ad performance and get one answer:
ad → visit → lead → customer → revenue → location.

## Status
Slice 1: Home page and shell (in progress)

## Stack
React + Tailwind (Google AI Studio) · Firebase Auth/Firestore · Cloud Functions

## Rules
- Never commit secrets. Use .env locally (git-ignored) and Cloud Function secrets in production.
- The OpenAI Conversions API key is only used server-side.
- Geography is aggregated to country/region/city. No individual location tracking.

## Docs
See /docs
