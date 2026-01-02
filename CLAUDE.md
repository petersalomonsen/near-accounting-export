# AI Agent Instructions

This file provides guidance for AI coding assistants working on this project.

## Project Documentation

For comprehensive project documentation, architecture details, and development conventions, see:

**[Copilot Instructions](./.github/copilot-instructions.md)**

This document contains:
- Project overview and architecture
- Building and testing instructions
- Environment variables
- Key conventions and patterns
- Test-Driven Development approach

## Quick Reference

**Language**: TypeScript (ES Modules)

**Build**: `npm run build` (compiles to `dist/`)

**Test**: `npm test` or `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`

**Development**: Follow the Test-Driven Development approach documented in copilot-instructions.md

## Important Notes

- Always read the full [copilot-instructions.md](./.github/copilot-instructions.md) before making significant changes
- Follow the TDD approach: write failing tests first, then implement fixes
- Use TypeScript strict typing throughout
- Handle errors gracefully with proper stop signal mechanisms
